"""Latent Size Picker - version 1.0.0 (VicNodes).

Image-only size picker. WAN 14B uses the same ordinary 4D zero latent as
comfyui_essentials; ComfyUI's KSampler normalizes it for the connected model.
WAN 5B uses the native specialized empty latent generator with one time slice.
"""

from __future__ import annotations

import importlib
import logging
import math
import re

LOG = logging.getLogger("LatentSizePicker")

# Preserves the Essentials-style resolutions (including the aspect labels)
# and adds a few common image sizes. No dependency on comfyui_essentials.
_RESOLUTIONS = (
    (512, 512), (768, 768), (768, 1024), (1024, 768),
    (704, 1408), (704, 1344), (768, 1344), (768, 1280),
    (832, 1216), (832, 1152), (896, 1152), (896, 1088),
    (960, 1088), (960, 1024), (1024, 1024), (1024, 960),
    (1088, 960), (1088, 896), (1152, 896), (1152, 832),
    (1216, 832), (1280, 768), (1344, 768), (1344, 704),
    (1408, 704), (1472, 704), (1536, 640), (1600, 640),
    (1664, 576), (1728, 576),
    (720, 1280), (1280, 720), (1024, 1536), (1536, 1024),
    (1536, 1536), (2048, 2048),
)


def _label(width: int, height: int) -> str:
    return f"{width}x{height} ({round(width / height, 2)})"


PRESETS = tuple(dict.fromkeys(_label(w, h) for w, h in _RESOLUTIONS))
DEFAULT_PRESET = _label(1024, 1024)

# Image-only wrappers that reuse Wan's latent format name, but whose native
# ComfyUI workflows use a 4D EmptySD3LatentImage (16 channels).
IMAGE_WAN_FORMAT_MODELS = {
    "anima", "qwen_image", "krea2", "joyimage",
}

# Other temporal formats are still deliberately unsupported. Wan 2.1 / 2.2
# are handled separately after checking native latent metadata.
VIDEO_MODEL_HINTS = (
    "hunyuanvideo", "hunyuan_video", "mochi", "ltxv",
    "cosmosvideo", "cogvideo", "video",
)

NATIVE_NODES = {
    "standard": ("nodes", "EmptyLatentImage"),
    "sd3": ("comfy_extras.nodes_sd3", "EmptySD3LatentImage"),
    "flux2": ("comfy_extras.nodes_flux", "EmptyFlux2LatentImage"),
    # qwen21 and hunyuan21 use the native EmptyLatentImage and ComfyUI's
    # fix_empty_latent_channels to convert to their exact 64-channel formats.
    "qwen21": ("nodes", "EmptyLatentImage"),
    "hunyuan21": ("nodes", "EmptyLatentImage"),
    # WAN 2.1 / 2.2 14B: imitate Essentials exactly. KSampler's native
    # fix_empty_latent_channels expands to 16ch, 5D, one temporal slice.
    "wan21": ("nodes", "EmptyLatentImage"),
    # WAN 2.2 TI2V 5B needs the native 48ch/16x format. One frame only.
    "wan22": ("comfy_extras.nodes_wan", "Wan22ImageToVideoLatent"),
}

LATENT_OPTIONS = [
    "Auto",
    "Standard (SD1.x / SDXL)",
    "SD3 / FLUX.1 (16ch)",
    "FLUX.2 / MOSS (128ch)",
]
LATENT_PROFILE = {
    LATENT_OPTIONS[1]: "standard",
    LATENT_OPTIONS[2]: "sd3",
    LATENT_OPTIONS[3]: "flux2",
}


def _model_info(model):
    """Read ComfyUI ModelPatcher metadata without loading/reloading weights."""
    base = getattr(model, "model", None)
    if base is None:
        raise ValueError("Auto requires a valid ComfyUI MODEL (ModelPatcher).")

    name = type(base).__name__.lower()
    config = getattr(base, "model_config", None)
    config_name = type(config).__name__.lower() if config is not None else ""
    unet_cfg = getattr(config, "unet_config", None)
    image_model = str(unet_cfg.get("image_model", "")).lower() if isinstance(unet_cfg, dict) else ""
    latent = getattr(base, "latent_format", None)
    if latent is None and config is not None:
        latent = getattr(config, "latent_format", None)
    if latent is None:
        raise ValueError("The connected MODEL exposes no native latent_format; select a manual latent_type.")

    # May be a format instance or a class on ComfyUI versions using different
    # supported-model definitions.
    fmt_name = (latent.__name__ if isinstance(latent, type) else type(latent).__name__).lower()
    channels = getattr(latent, "latent_channels", None)
    dimensions = getattr(latent, "latent_dimensions", None)
    spatial_ratio = getattr(latent, "spacial_downscale_ratio", None)
    return name, config_name, image_model, fmt_name, channels, dimensions, spatial_ratio


def _detect_native_profile(model):
    base_name, config_name, image_model, fmt, channels, dims, spatial = _model_info(model)
    identifier = " ".join([base_name, config_name, image_model])

    # Explicit 64-channel image formats. Reuse ComfyUI's built-in
    # empty-latent conversion (not a custom torch allocator).
    if fmt == "qwenimage21" and channels == 64 and dims in (None, 2) and spatial == 16:
        return "qwen21"
    if fmt == "hunyuanimage21" and channels == 64 and dims in (None, 2) and spatial == 32:
        return "hunyuan21"

    if fmt == "flux2" and channels == 128 and spatial == 16 and dims in (None, 2):
        return "flux2"
    if fmt in {"sd15", "sdxl", "sdxl_playground_2_5"} and channels == 4 and dims in (None, 2):
        return "standard"
    if fmt in {"sd3", "flux"} and channels == 16 and dims in (None, 2):
        return "sd3"

    # Anima / Krea2 / original Qwen Image store Wan21 as the latent format,
    # yet their still-image workflows use a 4D 16-channel native SD3 latent.
    if fmt == "wan21" and channels == 16 and (
        image_model in IMAGE_WAN_FORMAT_MODELS
        or base_name in {"anima", "qwenimage", "krea2", "joyimage"}
    ):
        return "sd3"

    # The Wan 2.2 14B models still use Wan21: 16 channels, x8 spatial,
    # x4 temporal. Wan 2.2 TI2V 5B uses Wan22: 48 channels, x16 spatial,
    # x4 temporal. Restrict this to actual Wan video models: other image
    # models may reuse the Wan latent format (for example PAN2).
    if (image_model in {"wan2.1", "wan2.2"}
            and dims == 3 and fmt == "wan21"
            and channels == 16 and spatial == 8):
        return "wan21"
    if (image_model in {"wan2.1", "wan2.2"}
            and dims == 3 and fmt == "wan22"
            and channels == 48 and spatial == 16):
        return "wan22"

    if any(hint in identifier for hint in VIDEO_MODEL_HINTS) or (dims not in (None, 2)):
        raise ValueError(
            "The connected MODEL uses a video/temporal latent that is not "
            "supported by Latent Size Picker. Wan 2.1 / 2.2 T2V models "
            "are supported; use a dedicated native latent node for other formats."
        )

    raise ValueError(
        f"Unsupported MODEL latent format: {fmt!r}, channels={channels}, "
        f"dimensions={dims}, downscale={spatial}, model={base_name}. "
        "Select an explicit type only after checking the native model requirements."
    )


def _align_16(value: float) -> int:
    return max(16, int(math.floor(value / 16.0 + 0.5)) * 16)


def _calculate_size(resolution, orientation, width_override,
                    height_override, lock_aspect_ratio, megapixels_target):
    match = re.match(r"^(\d+)x(\d+)\s*\(", resolution)
    if not match:
        raise ValueError(f"Invalid resolution preset: {resolution!r}")
    w = int(match.group(1))
    h = int(match.group(2))
    if orientation == "Portrait" and w > h:
        w, h = h, w
    elif orientation == "Landscape" and h > w:
        w, h = h, w
    base_ratio = w / h

    wo, ho = int(width_override), int(height_override)
    if wo > 0 and ho > 0:
        # Explicit pair is always authoritative.
        w, h = wo, ho
    elif wo > 0:
        w = wo
        if lock_aspect_ratio:
            h = w / base_ratio
    elif ho > 0:
        h = ho
        if lock_aspect_ratio:
            w = h * base_ratio

    target = float(megapixels_target)
    if target > 0:
        scale = math.sqrt(target * 1_000_000 / (w * h))
        w, h = w * scale, h * scale
    w, h = _align_16(w), _align_16(h)
    if w > 16384 or h > 16384:
        raise ValueError("Final dimensions exceed ComfyUI's 16384-pixel limit.")
    return w, h


def _run_native_empty(profile: str, width: int, height: int,
                      batch_size: int):
    module_name, class_name = NATIVE_NODES[profile]
    try:
        node_class = getattr(importlib.import_module(module_name), class_name)
    except (ImportError, AttributeError) as exc:
        raise RuntimeError(
            f"Native ComfyUI node {class_name} was not found. "
            "Update ComfyUI to a version that includes it."
        ) from exc

    instance = node_class()
    native_args = (width, height)
    native_kwargs = {"batch_size": batch_size}
    if profile == "wan22":
        native_kwargs["length"] = 1  # image-only, hidden fixed frame count
        # Native Wan22ImageToVideoLatent takes VAE as its first argument. It
        # only accesses VAE when start_image is connected, so we can invoke
        # the native empty-latent path with None and no extra picker input.
        native_args = ()
        native_kwargs.update(vae=None, width=width, height=height,
                             start_image=None)
    if hasattr(instance, "execute"):
        result = instance.execute(*native_args, **native_kwargs)
    elif hasattr(instance, "generate"):
        result = instance.generate(*native_args, **native_kwargs)
    else:
        function = getattr(instance, "FUNCTION", None)
        if not function or not hasattr(instance, function):
            raise RuntimeError(f"Native ComfyUI node {class_name} has no callable generation method.")
        result = getattr(instance, function)(*native_args, **native_kwargs)

    # ComfyUI v3: io.NodeOutput(...). Older versions: (latent_dict,).
    if isinstance(result, dict) and "result" in result:
        result = result["result"]
    elif hasattr(result, "result"):
        result = result.result
    if isinstance(result, (tuple, list)):
        result = result[0]
    if not isinstance(result, dict) or "samples" not in result:
        raise RuntimeError(f"Native ComfyUI node {class_name} returned an unexpected result.")

    # Validate to avoid silently returning a wrong format after upstream changes.
    expected_channels = {"standard": 4, "sd3": 16, "flux2": 128,
                         "qwen21": 4, "hunyuan21": 4,
                         "wan21": 4, "wan22": 48}[profile]
    expected_dims = 5 if profile == "wan22" else 4
    actual_shape = getattr(result["samples"], "shape", None)
    if (actual_shape is None or len(actual_shape) != expected_dims
            or int(actual_shape[1]) != expected_channels):
        raise RuntimeError(
            f"Native {class_name} returned an incompatible latent shape {actual_shape}; "
            f"expected {expected_dims}D with {expected_channels} channels."
        )
    if profile == "wan22":
        # Some ComfyUI builds of Wan22ImageToVideoLatent return a single empty
        # item even when batch_size > 1. Reuse the native repeat helper to
        # preserve the picker's existing batch-size contract.
        if batch_size > 1 and actual_shape[0] == 1:
            try:
                native_utils = importlib.import_module("comfy.utils")
                repeat = getattr(native_utils, "repeat_to_batch_size")
            except (ImportError, AttributeError) as exc:
                raise RuntimeError("ComfyUI's native repeat_to_batch_size is unavailable.") from exc
            result = {**result, "samples": repeat(result["samples"], batch_size, dim=0)}
            actual_shape = result["samples"].shape
        expected_shape = (batch_size, 48, 1, height // 16, width // 16)
        if tuple(actual_shape) != expected_shape:
            raise RuntimeError(
                f"Native {class_name} returned {actual_shape}; expected {expected_shape}."
            )
    if profile == "wan21":
        # Identical to Essentials' Empty Latent Size Picker output. The core
        # KSampler applies fix_empty_latent_channels using the actual MODEL.
        expected_shape = (batch_size, 4, height // 8, width // 8)
        if tuple(actual_shape) != expected_shape:
            raise RuntimeError(
                f"Native EmptyLatentImage returned {actual_shape}; expected {expected_shape}."
            )
    return result


def _run_native_model_adjustment(model, latent, profile, width, height):
    """Delegate conversion of 4ch/8x zeros to the model's true format to ComfyUI.

    ComfyUI's sampler itself uses fix_empty_latent_channels for converting
    empty latents. Calling the native implementation here lets our LATENT
    output already have the proper native layout, including for downstream
    consumers that inspect it before sampling.
    """
    if profile not in ("qwen21", "hunyuan21"):
        return latent
    if model is None:
        raise ValueError(f"The {profile} latent format requires MODEL for native conversion.")
    try:
        native_sample = importlib.import_module("comfy.sample")
        native_fix = getattr(native_sample, "fix_empty_latent_channels")
    except (ImportError, AttributeError) as exc:
        raise RuntimeError(
            "ComfyUI's native fix_empty_latent_channels API is not available. "
            "Update ComfyUI before using this model with Latent Size Picker."
        ) from exc

    # EmptyLatentImage emits 4ch at scale 8; Qwen/Hunyuan image need 64ch.
    samples = native_fix(model, latent["samples"], downscale_ratio_spacial=8)
    shape = getattr(samples, "shape", None)
    expected_downscale = {"qwen21": 16, "hunyuan21": 32}[profile]
    expected_shape = (int(latent["samples"].shape[0]), 64,
                      height // expected_downscale, width // expected_downscale)
    if shape is None or tuple(shape) != expected_shape:
        raise RuntimeError(
            f"ComfyUI returned {shape!r} for {profile}, "
            f"but expected {expected_shape}. Check the native ComfyUI version."
        )
    return {**latent, "samples": samples}


class LatentSizePicker:
    """One resolution selector, multiple *native* ComfyUI latent generators."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "resolution": (list(PRESETS), {"default": DEFAULT_PRESET,
                    "tooltip": "Select a resolution. Width and height outputs always reflect the final size."}),
                "latent_type": (LATENT_OPTIONS, {"default": "Auto",
                    "tooltip": "Auto reads the connected MODEL's native latent format; unknown models fail with a helpful error."}),
                "orientation": (["As selected", "Portrait", "Landscape"], {"default": "As selected"}),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096, "step": 1}),
                "width_override": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 16}),
                "height_override": ("INT", {"default": 0, "min": 0, "max": 16384, "step": 16}),
                "lock_aspect_ratio": ("BOOLEAN", {"default": True,
                    "tooltip": "When only one override is set, scale the other dimension to preserve the preset ratio. Two overrides are used as-is."}),
                "megapixels_target": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 268.0, "step": 0.1,
                    "round": 0.01, "tooltip": "0 disables MP scaling. A positive value scales the chosen aspect ratio to approximately this many megapixels."}),
            },
            "optional": {
                "model": ("MODEL", {"tooltip": "Required for Auto latent selection; not required if latent_type is set manually."}),
            },
        }

    RETURN_TYPES = ("LATENT", "INT", "INT", "FLOAT", "FLOAT")
    RETURN_NAMES = ("LATENT", "width", "height", "aspect_ratio", "megapixels")
    FUNCTION = "generate"
    CATEGORY = "VicNodes/Latent Size Picker"
    DESCRIPTION = (
        "Choose a resolution and generate an empty latent using native ComfyUI "
        "nodes. WAN 2.1/2.2 T2V uses an image-only single-frame latent. "
        "For video generation use the native WAN video nodes."
    )

    def generate(self, resolution=DEFAULT_PRESET, latent_type="Auto",
                 orientation="As selected", batch_size=1,
                 width_override=0, height_override=0,
                 lock_aspect_ratio=True, megapixels_target=0.0, model=None,
                 length=None):
        width, height = _calculate_size(
            resolution, orientation, width_override, height_override,
            lock_aspect_ratio, megapixels_target,
        )
        if latent_type == "Auto":
            if model is None:
                raise ValueError(
                    "latent_type is Auto, but MODEL is not connected. "
                    "Connect a MODEL or choose a manual latent_type."
                )
            profile = _detect_native_profile(model)
        else:
            profile = LATENT_PROFILE.get(latent_type)
            if profile is None:
                raise ValueError(f"Unknown latent_type: {latent_type!r}")
            if model is not None:
                detected = _detect_native_profile(model)
                if detected != profile:
                    raise ValueError(
                        f"Manual latent_type selects {profile}, but the connected "
                        f"MODEL expects {detected}. Select Auto or disconnect MODEL."
                    )

        # Hunyuan Image 2.1 has 32x latent compression. Qwen Image 2.1's
        # native text-encode workflow also rounds reference sizes to 32px.
        # Keep all sizes compatible without introducing another widget.
        if profile in ("qwen21", "hunyuan21"):
            width = max(32, int(math.floor(width / 32.0 + 0.5)) * 32)
            height = max(32, int(math.floor(height / 32.0 + 0.5)) * 32)
        if profile in ("wan21", "wan22"):
            # Legacy workflows may still serialize a `length` field; ignored.
            # Only single-frame image generation is available.
            if width < 16 or height < 16:
                raise ValueError("WAN image dimensions must be at least 16 pixels.")
            if profile == "wan22":
                # The native Wan22ImageToVideoLatent UI uses 32px steps.
                # Follow that alignment for the 48-channel TI2V 5B format.
                width = max(32, int(math.floor(width / 32.0 + 0.5)) * 32)
                height = max(32, int(math.floor(height / 32.0 + 0.5)) * 32)
        latent = _run_native_empty(profile, width, height, int(batch_size))
        latent = _run_native_model_adjustment(model, latent, profile, width, height)
        LOG.debug("native=%s, profile=%s, dimensions=%sx%s, batch=%s",
                  NATIVE_NODES[profile][1], profile, width, height, batch_size)
        return latent, width, height, float(width / height), float(width * height / 1_000_000)


NODE_CLASS_MAPPINGS = {"VicLatentSizePicker": LatentSizePicker}
NODE_DISPLAY_NAME_MAPPINGS = {"VicLatentSizePicker": "Latent Size Picker"}
