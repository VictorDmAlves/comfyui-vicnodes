"""VAE Encode (Resize) — ComfyUI custom node.

Uses ComfyUI's native resize, VAE Encode and Repeat Latent Batch primitives.
Padding and framing are implemented with standard PyTorch operators.
No KJNodes runtime dependency.
"""

from __future__ import annotations

import math

import torch
import torch.nn.functional as F

import comfy.model_management
from comfy.utils import common_upscale
from nodes import MAX_RESOLUTION, RepeatLatentBatch, VAEEncode


METHODS = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]
MODES = [
    "stretch", "resize", "pad", "pad_edge", "pad_edge_pixel",
    "crop", "pillarbox_blur", "total_pixels",
]
POSITIONS = ["center", "top", "bottom", "left", "right"]


def _multiple_down(size: int, multiple: int) -> int:
    """Keep size unchanged when multiple is 0/1, else round down."""
    size = int(size)
    if multiple > 1:
        size -= size % multiple
    if size < 1:
        raise ValueError(
            "VAE Encode (Resize): resulting dimension is 0. "
            "Increase width/height or lower divisible_by."
        )
    return size


def _position_offsets(extra_x: int, extra_y: int, position: str) -> tuple[int, int]:
    """Return upper-left origin for a framed foreground or crop."""
    x = extra_x // 2
    y = extra_y // 2
    if position == "top":
        y = 0
    elif position == "bottom":
        y = extra_y
    elif position == "left":
        x = 0
    elif position == "right":
        x = extra_x
    return x, y


def _scale(image: torch.Tensor, width: int, height: int, method: str) -> torch.Tensor:
    if image.shape[2] == width and image.shape[1] == height:
        return image
    return common_upscale(image.movedim(-1, 1), width, height, method, "disabled").movedim(1, -1)


def _gaussian(image: torch.Tensor, sigma: float) -> torch.Tensor:
    """Separable Gaussian blur with standard torch ops, image in NCHW."""
    radius = max(1, math.ceil(sigma * 3))
    coords = torch.arange(-radius, radius + 1, device=image.device, dtype=image.dtype)
    kernel = torch.exp(-0.5 * (coords / sigma).square())
    kernel = kernel / kernel.sum()
    channels = image.shape[1]
    kernel_h = kernel.view(1, 1, 1, -1).expand(channels, 1, 1, -1)
    kernel_v = kernel.view(1, 1, -1, 1).expand(channels, 1, -1, 1)
    image = F.conv2d(image, kernel_h, padding=(0, radius), groups=channels)
    return F.conv2d(image, kernel_v, padding=(radius, 0), groups=channels)


def _pad_image(
    image: torch.Tensor, target_w: int, target_h: int,
    left: int, top: int, mode: str,
) -> torch.Tensor:
    """Apply border framing to BHWC images. Uses a black solid fill for pad."""
    batch, src_h, src_w, channels = image.shape
    right = target_w - src_w - left
    bottom = target_h - src_h - top
    if min(left, right, top, bottom) < 0:
        raise ValueError("VAE Encode (Resize): invalid border geometry")
    if left == right == top == bottom == 0:
        return image

    if mode == "pad_edge_pixel":
        return F.pad(image.movedim(-1, 1), (left, right, top, bottom), mode="replicate").movedim(1, -1)

    if mode == "pillarbox_blur":
        # Fill the output with a cover-fitted, blurred, darkened copy of the image.
        scale = max(target_w / src_w, target_h / src_h)
        bg_w = max(target_w, round(src_w * scale))
        bg_h = max(target_h, round(src_h * scale))
        background = _scale(image, bg_w, bg_h, "bilinear")
        x = (bg_w - target_w) // 2
        y = (bg_h - target_h) // 2
        background = background[:, y:y + target_h, x:x + target_w, :].movedim(-1, 1)
        background = _gaussian(background, max(1.0, 0.006 * min(target_w, target_h)))
        if channels >= 3:
            rgb = background[:, :3]
            gray = (rgb[:, 0:1] * 0.2126 + rgb[:, 1:2] * 0.7152 + rgb[:, 2:3] * 0.0722)
            background[:, :3] = rgb * 0.8 + gray * 0.2
        background = (background * 0.35).clamp(0, 1).movedim(1, -1)
        background[:, top:top + src_h, left:left + src_w, :] = image
        return background

    # pad uses solid black. pad_edge uses the mean color of each source border.
    output = torch.zeros((batch, target_h, target_w, channels), dtype=image.dtype, device=image.device)
    if mode == "pad_edge":
        if top:
            top_mean = image[:, 0, :, :].mean(dim=1)[:, None, None, :]
            output[:, :top, :, :] = top_mean
        if bottom:
            bottom_mean = image[:, -1, :, :].mean(dim=1)[:, None, None, :]
            output[:, top + src_h:, :, :] = bottom_mean
        if left:
            left_mean = image[:, :, 0, :].mean(dim=1)[:, None, None, :]
            output[:, :, :left, :] = left_mean
        if right:
            right_mean = image[:, :, -1, :].mean(dim=1)[:, None, None, :]
            output[:, :, left + src_w:, :] = right_mean
    output[:, top:top + src_h, left:left + src_w, :] = image
    return output


def _resize_image(
    image: torch.Tensor, width: int, height: int, method: str,
    mode: str, position: str, divisible_by: int,
) -> torch.Tensor:
    """Return BHWC image, respecting KJNodes' resize mode semantics."""
    _, src_h, src_w, _ = image.shape
    # A zero dimension means 'auto', including in stretch mode.
    if width == 0 and height == 0:
        box_w, box_h = src_w, src_h
    elif width == 0:
        box_h = height
        # stretch/crop treat 0 as the original axis, like Resize Image v2.
        box_w = src_w if mode in ("stretch", "crop") else max(1, round(src_w * (height / src_h)))
    elif height == 0:
        box_w = width
        box_h = src_h if mode in ("stretch", "crop") else max(1, round(src_h * (width / src_w)))
    else:
        box_w, box_h = width, height

    if mode == "total_pixels":
        pixel_budget = box_w * box_h
        ratio = src_w / src_h
        target_w = max(1, round(math.sqrt(pixel_budget * ratio)))
        target_h = max(1, round(math.sqrt(pixel_budget / ratio)))
        target_w = _multiple_down(target_w, divisible_by)
        target_h = _multiple_down(target_h, divisible_by)
        return _scale(image, target_w, target_h, method)

    if mode == "resize":
        factor = min(box_w / src_w, box_h / src_h)
        target_w = _multiple_down(max(1, round(src_w * factor)), divisible_by)
        target_h = _multiple_down(max(1, round(src_h * factor)), divisible_by)
        return _scale(image, target_w, target_h, method)

    target_w = _multiple_down(box_w, divisible_by)
    target_h = _multiple_down(box_h, divisible_by)
    if mode == "stretch":
        return _scale(image, target_w, target_h, method)

    if mode == "crop":
        # Cover the target aspect by trimming source pixels *before* scaling.
        wanted_ratio = target_w / target_h
        src_ratio = src_w / src_h
        if src_ratio > wanted_ratio:
            crop_h = src_h
            crop_w = max(1, min(src_w, round(src_h * wanted_ratio)))
        else:
            crop_w = src_w
            crop_h = max(1, min(src_h, round(src_w / wanted_ratio)))
        x, y = _position_offsets(src_w - crop_w, src_h - crop_h, position)
        cropped = image[:, y:y + crop_h, x:x + crop_w, :]
        return _scale(cropped, target_w, target_h, method)

    # Fit the image inside a fixed canvas, preserving aspect ratio.
    factor = min(target_w / src_w, target_h / src_h)
    fitted_w = max(1, min(target_w, round(src_w * factor)))
    fitted_h = max(1, min(target_h, round(src_h * factor)))
    scaled = _scale(image, fitted_w, fitted_h, method)
    left, top = _position_offsets(target_w - fitted_w, target_h - fitted_h, position)
    return _pad_image(scaled, target_w, target_h, left, top, mode)


class VicVAEEncodeResize:
    """Resize and encode images, optionally repeating the resulting latent batch."""

    SEARCH_ALIASES = ["vae encode resize", "resize image to latent", "img2img vae"]
    DESCRIPTION = (
        "Resizes IMAGE pixels using ComfyUI native interpolation before VAE encoding. "
        "Then repeats the resulting latent via Repeat Latent Batch. "
        "0 for width/height uses automatic source-proportional sizing. "
        "Lanczos processing is CPU-only; GPU mode requires a different method."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pixels": ("IMAGE",),
                "vae": ("VAE",),
                "width": ("INT", {"default": 0, "min": 0, "max": MAX_RESOLUTION, "step": 1,
                                  "tooltip": "Target width in pixels; 0 uses the input width or computes it proportionally."}),
                "height": ("INT", {"default": 0, "min": 0, "max": MAX_RESOLUTION, "step": 1,
                                   "tooltip": "Target height in pixels; 0 uses the input height or computes it proportionally."}),
                "upscale_method": (METHODS, {"default": "bicubic"}),
                "keep_proportional": (MODES, {"default": "stretch"}),
                "crop_position": (POSITIONS, {"default": "center"}),
                "latent_amount": ("INT", {"default": 1, "min": 1, "max": 64, "step": 1,
                                         "tooltip": "Repeat the encoded latent batch; matches native Repeat Latent Batch."}),
                "divisible_by": ("INT", {"default": 8, "min": 0, "max": 512, "step": 1,
                                        "tooltip": "Snap output width and height down to a multiple (0/1 disables)."}),
                "device": (["cpu", "gpu"], {"default": "cpu",
                                         "tooltip": "Resize/padding device only; VAE encoding uses its normal ComfyUI device."}),
            }
        }

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("latent",)
    FUNCTION = "encode"
    CATEGORY = "VicNodes/VAE Encode"

    def encode(
        self, pixels, vae, width=0, height=0,
        upscale_method="bicubic", keep_proportional="stretch", crop_position="center",
        latent_amount=1, divisible_by=8, device="cpu",
    ):
        if pixels.ndim != 4 or pixels.shape[0] == 0 or pixels.shape[-1] < 3:
            raise ValueError("VAE Encode (Resize): pixels must be a non-empty BHWC IMAGE with RGB channels.")
        if keep_proportional not in MODES or crop_position not in POSITIONS or upscale_method not in METHODS:
            raise ValueError("VAE Encode (Resize): unknown resize mode, position or interpolation method.")

        # Plan without any device transfer; skip the whole resize if it's a no-op.
        # Do not force the VAE into cpu/gpu; its own device management stays native.
        desired_device = torch.device("cpu") if device == "cpu" else comfy.model_management.get_torch_device()
        # Lanczos is provided by the native common_upscale CPU/PIL path only.
        # Detect whether interpolation is actually needed before raising an error.
        source_h, source_w = pixels.shape[1:3]
        if (width == 0 and height == 0 and keep_proportional != "total_pixels"
                and (divisible_by <= 1 or (source_w % divisible_by == 0 and source_h % divisible_by == 0))):
            resized = pixels
        else:
            if upscale_method == "lanczos" and device == "gpu":
                raise ValueError("VAE Encode (Resize): lanczos requires device=cpu. Select cpu or another method.")
            # Transfer only for the pixel transformations; preserve ComfyUI VAE handling.
            image = pixels if pixels.device == desired_device else pixels.to(desired_device)
            resized = _resize_image(
                image, int(width), int(height), upscale_method,
                keep_proportional, crop_position, int(divisible_by),
            )
            # Keep intermediate image tensors off VRAM when the VAE is invoked.
            resized = resized.cpu()

        native_latent = VAEEncode().encode(vae=vae, pixels=resized)[0]
        if int(latent_amount) > 1:
            native_latent = RepeatLatentBatch().repeat(native_latent, int(latent_amount))[0]
        return (native_latent,)


NODE_CLASS_MAPPINGS = {"VicVAEEncodeResize": VicVAEEncodeResize}
NODE_DISPLAY_NAME_MAPPINGS = {"VicVAEEncodeResize": "VAE Encode (Resize)"}
