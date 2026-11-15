"""VicNodes Smart Tile - experimental, SeedVR2-agnostic two-node tiling bridge.

ComfyUI images are BHWC tensors. IMAGE list outputs are deliberately separate
one-frame tensors, allowing video upscalers to process each tile independently.
"""
from __future__ import annotations

import logging
import math
from typing import Any

import torch
import torch.nn.functional as F

_LOG = logging.getLogger("VicNodes.SmartTile")
_FORMAT = "VIC_TILE_INFO"
_VERSION = 1
_METHODS = ["lanczos", "bicubic", "bilinear", "area", "nearest-exact"]
_MAX_TILES = 256


def _resize(image: torch.Tensor, width: int, height: int, method: str) -> torch.Tensor:
    """Match ComfyUI's native ImageScaleBy where possible, without extra packages."""
    if width < 1 or height < 1:
        raise ValueError(f"Smart Tile: invalid resize target {width}x{height}.")
    if image.shape[1:3] == (height, width):
        return image
    import comfy.utils
    nchw = image.movedim(-1, 1)
    result = comfy.utils.common_upscale(nchw, width, height, method, "disabled")
    return result.movedim(1, -1).clamp(0, 1)


def _validate_image(image: torch.Tensor, label: str) -> None:
    if not isinstance(image, torch.Tensor) or image.ndim != 4:
        raise ValueError(f"Smart Tile: {label} must be an IMAGE tensor [B,H,W,C].")
    if image.shape[0] < 1 or image.shape[1] < 1 or image.shape[2] < 1:
        raise ValueError(f"Smart Tile: {label} has an empty batch or dimensions.")
    if image.shape[3] not in (3, 4):
        raise ValueError(f"Smart Tile: {label} must have RGB or RGBA channels.")


def _one(value: Any, name: str):
    if not isinstance(value, list) or not value:
        raise ValueError(f"Smart Tile: invalid list input '{name}'.")
    return value[0]


def _partitions(length: int, count: int) -> list[tuple[int, int]]:
    """Unequal but gapless partitions; no pixels discarded."""
    return [(i * length // count, (i + 1) * length // count) for i in range(count)]


def _make_layout(width: int, height: int, rows: int, cols: int,
                 overlap: float, extra_x: int, extra_y: int,
                 layout_mode: str) -> tuple[list[dict], int, int, int, int]:
    """Return placements, output size and overlap in pixels."""
    legacy = layout_mode == "Essentials compatible"
    if legacy:
        tw, th = width // cols, height // rows
        canvas_w, canvas_h = tw * cols, th * rows
        parts_x = [(i * tw, (i + 1) * tw) for i in range(cols)]
        parts_y = [(i * th, (i + 1) * th) for i in range(rows)]
    else:
        canvas_w, canvas_h = width, height
        parts_x = _partitions(width, cols)
        parts_y = _partitions(height, rows)

    min_w = min(b-a for a, b in parts_x)
    min_h = min(b-a for a, b in parts_y)
    if min_w <= 0 or min_h <= 0:
        raise ValueError("Smart Tile: grid is larger than the image. Reduce rows or cols.")
    ox = min(min_w // 2, int(min_w * overlap) + extra_x) if cols > 1 else 0
    oy = min(min_h // 2, int(min_h * overlap) + extra_y) if rows > 1 else 0
    placements = []
    for row, (core_y0, core_y1) in enumerate(parts_y):
        for col, (core_x0, core_x1) in enumerate(parts_x):
            if legacy:
                # Reproduce Image Tile from ComfyUI Essentials for divisible canvases.
                tw, th = width // cols, height // rows
                x0 = core_x0 - (ox if col > 0 else 0)
                y0 = core_y0 - (oy if row > 0 else 0)
                x1 = min(canvas_w, x0 + tw + ox)
                y1 = min(canvas_h, y0 + th + oy)
                if x1 - x0 < tw + ox:
                    x0 = x1 - tw - ox
                if y1 - y0 < th + oy:
                    y0 = y1 - th - oy
                # When a grid has one column/row, corresponding overlap == 0.
            else:
                x0 = max(0, core_x0 - ox)
                y0 = max(0, core_y0 - oy)
                x1 = min(canvas_w, core_x1 + ox)
                y1 = min(canvas_h, core_y1 + oy)
            placements.append({
                "row": row, "col": col,
                "x0": x0, "y0": y0, "x1": x1, "y1": y1,
                "core_x0": core_x0, "core_y0": core_y0,
                "core_x1": core_x1, "core_y1": core_y1,
            })
    return placements, canvas_w, canvas_h, ox, oy


def _ramp(length: int, kind: str, strength: float, dtype, device):
    if length <= 0:
        return torch.empty((0,), dtype=dtype, device=device)
    t = (torch.arange(length, dtype=dtype, device=device) + .5) / length
    t = ((t - .5) / max(strength, 0.0001) + .5).clamp(0, 1)
    if kind == "cosine":
        return .5 - .5 * torch.cos(t * math.pi)
    return t


def _weight(tile: dict, kind: str, strength: float, dtype, device) -> torch.Tensor:
    width = tile["x1"] - tile["x0"]
    height = tile["y1"] - tile["y0"]
    wx = torch.ones(width, dtype=dtype, device=device)
    wy = torch.ones(height, dtype=dtype, device=device)
    l = tile["core_x0"] - tile["x0"]
    r = tile["x1"] - tile["core_x1"]
    t = tile["core_y0"] - tile["y0"]
    b = tile["y1"] - tile["core_y1"]
    if l:
        wx[:l] = _ramp(l, kind, strength, dtype, device)
    if r:
        wx[-r:] = _ramp(r, kind, strength, dtype, device).flip(0)
    if t:
        wy[:t] = _ramp(t, kind, strength, dtype, device)
    if b:
        wy[-b:] = _ramp(b, kind, strength, dtype, device).flip(0)
    return wy[:, None, None] * wx[None, :, None]


def _legacy_mask(tile: dict, overlap_x: int, overlap_y: int, dtype, device):
    h = tile["y1"] - tile["y0"]
    w = tile["x1"] - tile["x0"]
    m = torch.ones((h,w,1), dtype=dtype, device=device)
    if tile["row"] > 0 and overlap_y:
        k = min(overlap_y, h)
        m[:k] *= torch.linspace(0, 1, k, device=device, dtype=dtype)[:,None,None]
    if tile["col"] > 0 and overlap_x:
        k = min(overlap_x, w)
        m[:,:k] *= torch.linspace(0, 1, k, device=device, dtype=dtype)[None,:,None]
    return m


class VicSmartTilePrepare:
    """Resize, partition, and emit ordered one-frame IMAGE list + metadata."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE", {"tooltip": "Source IMAGE, normally the second sampler's VAE Decode output."}),
            "upscale_by": ("FLOAT", {"default": 2.0, "min": 0.05, "max": 8.0, "step": .05,
                                   "tooltip": "First resize of the entire image, before tiling (same as native ImageScaleBy)."}),
            "upscale_method": (_METHODS, {"default": "lanczos"}),
            "rows": ("INT", {"default": 4, "min": 1, "max": 32, "step": 1}),
            "cols": ("INT", {"default": 4, "min": 1, "max": 32, "step": 1}),
            "overlap": ("FLOAT", {"default": .10, "min": 0.0, "max": .50, "step": .01,
                                 "tooltip": "Fraction of the base tile dimensions, plus overlap_x/y pixels (maximum 50% of tile)."}),
            "tile_scale": ("FLOAT", {"default": .25, "min": .05, "max": 4.0, "step": .05,
                                    "tooltip": "Second resize, of each tile individually, immediately before SeedVR2."}),
            "tile_resize_method": (_METHODS, {"default": "lanczos"}),
            "preview_mode": (["Grid", "Grid + Overlap", "Original", "SeedVR2 Input"], {
                "default": "Grid",
                "tooltip": "Clean, clickable image gallery in Preview Image. Grid shows core crops; "
                           "Grid + Overlap shows full overlap tiles; Original shows prepared full image; "
                           "SeedVR2 Input shows the reduced tiles fed to SeedVR2. No grid lines are painted."
            }),
            "layout_mode": (["Preserve full image", "Essentials compatible"], {
                "default": "Preserve full image", "advanced": True,
                "tooltip": "Preserve all border pixels, or match Essentials Image Tile placement (truncates trailing pixels when not divisible)."}),
            "overlap_x": ("INT", {"default": 0, "min": 0, "max": 2048, "step": 1, "advanced": True,
                                 "tooltip": "Extra horizontal overlap pixels, before tile_scale; added to fractional overlap."}),
            "overlap_y": ("INT", {"default": 0, "min": 0, "max": 2048, "step": 1, "advanced": True,
                                 "tooltip": "Extra vertical overlap pixels, before tile_scale; added to fractional overlap."}),
        }}

    RETURN_TYPES = ("IMAGE", "VIC_TILE_INFO", "IMAGE")
    RETURN_NAMES = ("tiles", "tile_info", "preview")
    # The preview is also a *real* IMAGE list: each tile keeps its own native
    # dimensions. The stock Preview Image node shows these as a clickable gallery.
    OUTPUT_IS_LIST = (True, False, True)
    FUNCTION = "execute"
    CATEGORY = "VicNodes/Smart Tile Upscaler"
    DESCRIPTION = "Prepare individual tiles for SeedVR2; the preview output is a clickable IMAGE gallery (no drawn guides)."

    def execute(self, image, upscale_by=2.0, upscale_method="lanczos", rows=4, cols=4,
                overlap=.10, tile_scale=.25, tile_resize_method="lanczos", preview_mode="Grid",
                layout_mode="Preserve full image", overlap_x=0, overlap_y=0):
        _validate_image(image, "input image")
        rows, cols = int(rows), int(cols)
        num = rows * cols * image.shape[0]
        if num > _MAX_TILES:
            raise ValueError(f"Smart Tile: {num} tiles exceeds safety limit of {_MAX_TILES}. Reduce rows/cols or batch size.")
        original_h, original_w = image.shape[1:3]
        new_w = max(1, round(original_w * float(upscale_by)))
        new_h = max(1, round(original_h * float(upscale_by)))
        if new_w * new_h > 16000 * 16000:
            raise ValueError("Smart Tile: resized canvas is too large (more than 256 megapixels).")
        prepared = _resize(image, new_w, new_h, upscale_method)
        placements, w, h, ox, oy = _make_layout(
            new_w, new_h, rows, cols, float(overlap), int(overlap_x), int(overlap_y), layout_mode)
        # No resize to the cropped area: keep the exact original prepared image but
        # emit the cropped preview in the compatibility case.
        effective_canvas = prepared[:, :h, :w, :]
        # A native ComfyUI IMAGE list is needed here (not a padded IMAGE batch):
        # overlap tiles may have different widths and heights at the canvas edges.
        # Never draw guide lines directly onto these previews.
        if preview_mode not in ("Grid", "Grid + Overlap", "Original", "SeedVR2 Input"):
            raise ValueError(f"Smart Tile Prepare: unsupported preview_mode '{preview_mode}'.")
        previews = []
        if preview_mode == "Original":
            previews = [effective_canvas[i:i+1] for i in range(image.shape[0])]
        tiles = []
        regions = []
        for source_index in range(image.shape[0]):
            for placement in placements:
                box = dict(placement)
                box["source_index"] = source_index
                box["tile_index"] = len(regions)
                x0, x1, y0, y1 = box["x0"], box["x1"], box["y0"], box["y1"]
                cut = prepared[source_index:source_index+1, y0:y1, x0:x1, :]
                tw = max(1, round((x1-x0) * float(tile_scale)))
                th = max(1, round((y1-y0) * float(tile_scale)))
                if tw < 16 or th < 16:
                    raise ValueError(f"Smart Tile: tile ({tw}x{th}) too small for SeedVR2. Increase tile_scale or reduce grid.")
                box["seed_width"], box["seed_height"] = tw, th
                scaled_tile = _resize(cut, tw, th, tile_resize_method).contiguous()
                tiles.append(scaled_tile)
                if preview_mode == "Grid":
                    # Clean core-only crop, with the overlap margins hidden.
                    cx0, cy0 = box["core_x0"], box["core_y0"]
                    cx1, cy1 = box["core_x1"], box["core_y1"]
                    previews.append(prepared[source_index:source_index+1, cy0:cy1, cx0:cx1, :])
                elif preview_mode == "Grid + Overlap":
                    # The complete overlapping tile before tile_scale.
                    previews.append(cut)
                elif preview_mode == "SeedVR2 Input":
                    # Exactly the image delivered to SeedVR2.
                    previews.append(scaled_tile)
                regions.append(box)
        info = {
            "format": _FORMAT, "version": _VERSION,
            "original_width": original_w, "original_height": original_h,
            "prepared_width": new_w, "prepared_height": new_h,
            "canvas_width": w, "canvas_height": h,
            "image_count": image.shape[0], "channels": image.shape[3],
            "rows": rows, "cols": cols, "overlap_x": ox, "overlap_y": oy,
            "layout_mode": layout_mode, "regions": regions,
        }
        _LOG.info("Smart Tile Prepare: %d images, %dx%d -> %dx%d, %d tiles (%dx%d), overlap %d/%d",
                  image.shape[0], original_w, original_h, w, h, len(tiles), rows, cols, ox, oy)
        return (tiles, info, previews)


class VicSmartTileReassemble:
    """Receive an IMAGE list that survived individual SeedVR2 executions."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "tiles": ("IMAGE", {"tooltip": "Connect the SeedVR2 IMAGE output directly. It must remain a list in row-major tile order."}),
            "tile_info": ("VIC_TILE_INFO", {"tooltip": "Connect Smart Tile | Prepare tile_info directly. Do not alter or split this metadata."}),
            "blend_mode": (["feather", "cosine", "legacy", "hard"], {
                "default": "feather", "tooltip": "feather/cosine use normalized weights; legacy mirrors the Essentials sequential fade; hard cuts to tile cores."}),
            "blend_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": .05,
                                       "tooltip": "Feather width, 0 = hard core cuts, 1 = full available overlap."}),
            "resize_method": (_METHODS, {"default": "lanczos",
                                         "tooltip": "Each processed tile is resized back to its exact stored pre-SeedVR2 dimensions."}),
            "output_scale": ("FLOAT", {"default": 1.0, "min": .05, "max": 4.0, "step": .05,
                                       "tooltip": "Applied after assembly (and after restore_original_size, if enabled)."}),
            "color_match": (["off", "overlap mean"], {"default": "off", "advanced": True,
                                                         "tooltip": "Optional limited mean RGB correction between tiles; can introduce shifts, use sparingly."}),
            "color_match_strength": ("FLOAT", {"default": .35, "min": 0.0, "max": 1.0, "step": .05,
                                             "advanced": True}),
            "restore_original_size": ("BOOLEAN", {"default": False, "advanced": True,
                "tooltip": "Resize reconstructed image back to the dimensions before initial upscale, before output_scale."}),
        }}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    INPUT_IS_LIST = True
    FUNCTION = "execute"
    CATEGORY = "VicNodes/Smart Tile Upscaler"
    DESCRIPTION = "Reassemble SeedVR2 tiles using exact Smart Tile metadata and configurable seam blending."

    def execute(self, tiles, tile_info, blend_mode, blend_strength, resize_method,
                output_scale, color_match, color_match_strength, restore_original_size):
        info = _one(tile_info, "tile_info")
        if not isinstance(info, dict) or info.get("format") != _FORMAT or info.get("version") != _VERSION:
            raise ValueError("Smart Tile Reassemble: tile_info must come from matching Smart Tile | Prepare.")
        regions = info.get("regions")
        if not isinstance(regions, list) or len(regions) != len(tiles):
            raise ValueError(f"Smart Tile Reassemble: expected {len(regions) if isinstance(regions,list) else '?'} "
                             f"processed tiles, received {len(tiles)}. Ensure SeedVR2 returns exactly one image per tile, "
                             "and do not insert Image List to Image Batch before this node.")
        mode = _one(blend_mode, "blend_mode")
        strength = float(_one(blend_strength, "blend_strength"))
        method = _one(resize_method, "resize_method")
        scale = float(_one(output_scale, "output_scale"))
        match = _one(color_match, "color_match")
        match_strength = float(_one(color_match_strength, "color_match_strength"))
        restore = bool(_one(restore_original_size, "restore_original_size"))
        if mode not in ("feather", "cosine", "legacy", "hard"):
            raise ValueError(f"Smart Tile Reassemble: unknown blend_mode '{mode}'.")
        if match not in ("off", "overlap mean"):
            raise ValueError(f"Smart Tile Reassemble: unknown color_match '{match}'.")

        outputs = []
        canvas_h = int(info["canvas_height"])
        canvas_w = int(info["canvas_width"])
        channels = int(info["channels"])
        count = int(info["image_count"])
        for source_index in range(count):
            selected = [(i, r) for i, r in enumerate(regions) if r["source_index"] == source_index]
            if not selected:
                raise ValueError(f"Smart Tile Reassemble: no tiles for source image {source_index}.")
            first_tile = tiles[selected[0][0]]
            _validate_image(first_tile, "processed tile")
            device, dtype = first_tile.device, first_tile.dtype
            # Accumulate in float32 for stable GPU/CPU weights even with half precision.
            accum = torch.zeros((canvas_h, canvas_w, channels), dtype=torch.float32, device=device)
            weight_total = torch.zeros((canvas_h, canvas_w, 1), dtype=torch.float32, device=device)
            if mode == "legacy":
                # Sequential fade exactly as Essentials-style Image Untile.
                composed = accum
            for index, region in selected:
                tile = tiles[index]
                _validate_image(tile, f"processed tile #{index}")
                if tile.shape[0] != 1:
                    raise ValueError(f"Smart Tile Reassemble: tile #{index} contains {tile.shape[0]} frames. "
                                     "SeedVR2 must return a single image for each input tile.")
                if tile.shape[-1] != channels:
                    raise ValueError("Smart Tile Reassemble: tiles have inconsistent channel counts (RGB/RGBA).")
                if tile.device != device:
                    tile = tile.to(device)
                x0,y0,x1,y1 = (int(region[k]) for k in ("x0","y0","x1","y1"))
                wanted_w, wanted_h = x1-x0, y1-y0
                if min(wanted_w,wanted_h) < 1 or x0 < 0 or y0 < 0 or x1 > canvas_w or y1 > canvas_h:
                    raise ValueError("Smart Tile Reassemble: corrupt tile geometry.")
                tile = _resize(tile, wanted_w, wanted_h, method)[0].to(torch.float32).clamp(0,1)

                if match == "overlap mean" and match_strength > 0:
                    prior = weight_total[y0:y1,x0:x1,0]
                    present = prior > 0.01
                    if present.any():
                        reference = (accum[y0:y1,x0:x1,:3] / prior.clamp_min(1e-6)[...,None])
                        delta = (reference[present].mean(dim=0) - tile[..., :3][present].mean(dim=0))
                        # Deliberately conservative; do not change alpha.
                        delta = delta.clamp(-.10, .10) * match_strength
                        tile[..., :3] = (tile[..., :3] + delta).clamp(0,1)

                if mode == "legacy":
                    m = _legacy_mask(region, int(info["overlap_x"]), int(info["overlap_y"]),
                                     torch.float32, device)
                    composed[y0:y1,x0:x1] = composed[y0:y1,x0:x1]*(1-m) + tile*m
                    weight_total[y0:y1,x0:x1] = 1
                elif mode == "hard" or strength <= 0:
                    cx0,cy0,cx1,cy1 = (int(region[k]) for k in
                                        ("core_x0","core_y0","core_x1","core_y1"))
                    sx0,sy0 = cx0-x0, cy0-y0
                    accum[cy0:cy1,cx0:cx1] = tile[sy0:sy0+(cy1-cy0),sx0:sx0+(cx1-cx0)]
                    weight_total[cy0:cy1,cx0:cx1] = 1
                else:
                    w = _weight(region, "cosine" if mode == "cosine" else "feather", strength,
                                torch.float32, device)
                    accum[y0:y1,x0:x1] += tile*w
                    weight_total[y0:y1,x0:x1] += w
            if (weight_total <= 0).any():
                raise ValueError("Smart Tile Reassemble: unfilled pixels; tile metadata is invalid.")
            if mode == "legacy":
                final = composed.clamp(0,1).unsqueeze(0)
            else:
                final = (accum / weight_total.clamp_min(1e-8)).clamp(0,1).unsqueeze(0)
            if restore:
                final = _resize(final, int(info["original_width"]), int(info["original_height"]), method)
            if abs(scale-1.0) > 1e-6:
                w = max(1, round(final.shape[2] * scale))
                h = max(1, round(final.shape[1] * scale))
                final = _resize(final, w, h, method)
            outputs.append(final)
        _LOG.info("Smart Tile Reassemble: %d tiles -> %d image(s), %dx%d",
                  len(tiles), len(outputs), outputs[0].shape[2], outputs[0].shape[1])
        return (torch.cat(outputs, dim=0),)


NODE_CLASS_MAPPINGS = {
    "VicSmartTilePrepare": VicSmartTilePrepare,
    "VicSmartTileReassemble": VicSmartTileReassemble,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VicSmartTilePrepare": "Smart Tile | Prepare",
    "VicSmartTileReassemble": "Smart Tile | Reassemble",
}
