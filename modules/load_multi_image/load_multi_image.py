"""Multi-slot image loader that keeps every IMAGE / MASK output independent."""

from __future__ import annotations

import configparser
import hashlib
import json
import logging
import os
from pathlib import Path

import folder_paths
import nodes
import torch

_LOG = logging.getLogger("ComfyUI-Load-Multi-Image")
_NONE = "(none)"


def _configured_max_images() -> int:
    # VicNodes-specific settings live outside replaceable module folders.
    # Preserve the v1.0.7 config.json/default behavior if no .conf is present.
    override_path = Path(__file__).resolve().parents[2] / "config" / "load_multi_image.conf"
    try:
        with override_path.open("r", encoding="utf-8") as source:
            parser = configparser.ConfigParser(interpolation=None)
            parser.read_file(source)
        if parser.has_option("load_multi_image", "max_images"):
            value = int(parser.get("load_multi_image", "max_images"))
            if not 1 <= value <= 32:
                raise ValueError("max_images must be between 1 and 32")
            return value
    except FileNotFoundError:
        pass
    except (OSError, UnicodeError, ValueError, TypeError, configparser.Error) as exc:
        _LOG.warning("Invalid config/load_multi_image.conf (%s); using module default", exc)

    config_path = Path(__file__).with_name("config.json")
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        value = int(config.get("max_images", 5))
        if not 1 <= value <= 32:
            raise ValueError("max_images must be between 1 and 32")
        return value
    except FileNotFoundError:
        return 5
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        _LOG.warning("Invalid config.json (%s); falling back to 5 images", exc)
        return 5


MAX_IMAGES = _configured_max_images()


def _is_selected(value) -> bool:
    return isinstance(value, str) and bool(value.strip()) and value.strip() != _NONE


def _file_choices() -> list[str]:
    root = folder_paths.get_input_directory()
    try:
        candidates = [f for f in os.listdir(root) if os.path.isfile(os.path.join(root, f))]
        valid = folder_paths.filter_files_content_types(candidates, ["image"])
        return [_NONE] + sorted(valid, key=str.casefold)
    except OSError as exc:
        _LOG.warning("Could not list ComfyUI input directory: %s", exc)
        return [_NONE]


def _blank_pair() -> tuple[torch.Tensor, torch.Tensor]:
    """Unused slots return valid placeholders, never None or invalid tensor types."""
    return (torch.zeros((1, 64, 64, 3), dtype=torch.float32),
            torch.zeros((1, 64, 64), dtype=torch.float32))


def _load_one(filename: str) -> tuple[torch.Tensor, torch.Tensor]:
    """Reuse ComfyUI's native loader, with full-size empty masks for opaque files."""
    image, mask = nodes.LoadImage().load_image(filename)
    height, width = image.shape[1], image.shape[2]
    if mask.shape[-2:] != (height, width):
        # Core's LoadImage conventionally returns a 64x64 empty mask for opaque
        # images.  Make the MASK from this node match its IMAGE dimensions.
        if not torch.any(mask):
            mask = torch.zeros((image.shape[0], height, width),
                               dtype=image.dtype, device=image.device)
        else:
            mask = torch.nn.functional.interpolate(
                mask.unsqueeze(1), size=(height, width), mode="nearest"
            ).squeeze(1)
    return image, mask


class LoadMultiImage:
    """Fixed backend schema, compact/dynamic frontend slots.

    Static backend RETURN_TYPES are required by ComfyUI's type validator.
    The JS UI adds/removes *trailing* port pairs without changing slot indices.
    """

    CATEGORY = "VicNodes/Load Multi Image"
    FUNCTION = "load_images"
    DESCRIPTION = (
        "Load multiple reference images independently. Each slot provides its "
        "own IMAGE and MASK, for separate VAE Encode, Reference Latent, or inpaint branches."
    )
    RETURN_TYPES = tuple(t for _ in range(MAX_IMAGES) for t in ("IMAGE", "MASK"))
    RETURN_NAMES = tuple(n for i in range(1, MAX_IMAGES + 1)
                         for n in (f"IMAGE {i}", f"MASK {i}"))

    @classmethod
    def INPUT_TYPES(cls):
        filenames = _file_choices()
        # All slots are required *widgets* to support stable prompt serialization,
        # but only image_1 needs an actual image to execute.
        return {"required": {
            f"image_{i}": (filenames, {"default": _NONE})
            for i in range(1, MAX_IMAGES + 1)
        }}

    def load_images(self, **kwargs):
        if not _is_selected(kwargs.get("image_1")):
            raise ValueError("Load Multi Image: select an image in slot 1 first.")

        loaded = {}
        result = []
        for i in range(1, MAX_IMAGES + 1):
            name = kwargs.get(f"image_{i}", _NONE)
            if not _is_selected(name):
                result.extend(_blank_pair())
                continue
            if name not in loaded:
                loaded[name] = _load_one(name)
            result.extend(loaded[name])
        return tuple(result)

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        if not _is_selected(kwargs.get("image_1", _NONE)):
            return "Load Multi Image: select an image in slot 1 first."
        for i in range(1, MAX_IMAGES + 1):
            filename = kwargs.get(f"image_{i}", _NONE)
            if _is_selected(filename) and not folder_paths.exists_annotated_filepath(filename):
                return f"Load Multi Image: image {i} not found: {filename}"
        return True

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Reexecute if a selected file is overwritten without a filename change.
        digest = hashlib.sha256()
        for i in range(1, MAX_IMAGES + 1):
            filename = kwargs.get(f"image_{i}", _NONE)
            digest.update(f"slot:{i}\x00{filename}\x00".encode("utf-8"))
            if not _is_selected(filename):
                continue
            try:
                path = folder_paths.get_annotated_filepath(filename)
                with open(path, "rb") as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        digest.update(chunk)
            except OSError:
                digest.update(b"missing")
        return digest.hexdigest()


_LOG.info("Load Multi Image v1.0.7: configured for %d image slots", MAX_IMAGES)
