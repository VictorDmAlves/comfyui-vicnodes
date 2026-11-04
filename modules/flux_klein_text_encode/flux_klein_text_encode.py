"""Compact FLUX.2 Klein text conditioning with native multi-image references.

Uses ComfyUI's native text encoding, reference_latents, and ConditioningZeroOut
logic. The number of visible autogrow image inputs comes from settings.config.
"""

import configparser
import logging
from pathlib import Path

import node_helpers
from comfy_api.latest import io


LOGGER = logging.getLogger(__name__)
CONFIG_PATH = Path(__file__).resolve().parent / "settings.config"
DEFAULT_MAX_IMAGES = 4
HARD_MAX_IMAGES = 10


def get_max_images():
    """Return the configured number of image sockets (1-10, default 4).

    A missing/invalid configuration never prevents the extension from loading.
    Restart ComfyUI after modifying settings.config to refresh the frontend.
    """
    if not CONFIG_PATH.exists():
        return DEFAULT_MAX_IMAGES

    parser = configparser.ConfigParser(interpolation=None)
    try:
        with CONFIG_PATH.open("r", encoding="utf-8-sig") as config_file:
            parser.read_file(config_file)
        max_images = parser.getint("references", "max_images")
    except (OSError, configparser.Error, ValueError) as exc:
        LOGGER.warning(
            "Flux Klein Text Encode: invalid settings.config (%s); using default %s.",
            exc,
            DEFAULT_MAX_IMAGES,
        )
        return DEFAULT_MAX_IMAGES

    if not 1 <= max_images <= HARD_MAX_IMAGES:
        LOGGER.warning(
            "Flux Klein Text Encode: max_images must be between 1 and %s; "
            "using default %s.",
            HARD_MAX_IMAGES,
            DEFAULT_MAX_IMAGES,
        )
        return DEFAULT_MAX_IMAGES
    return max_images


class FluxKleinTextEncode(io.ComfyNode):
    """Encode one prompt, attach native reference latents, then zero the negative."""

    @classmethod
    def define_schema(cls):
        max_images = get_max_images()
        return io.Schema(
            # Preserve v1.0.0's internal ID to keep existing workflows compatible.
            node_id="VicFluxKleinTextEncode",
            display_name="Text Encode Flux Klein",
            category="VicNodes/Flux Klein Text Encode",
            description=(
                "Encode a FLUX.2 Klein prompt and append native reference latents. "
                "The negative output uses ComfyUI's Conditioning Zero Out. "
                f"Image inputs: {max_images} (configured in settings.config; "
                "1-4 recommended, 5-10 experimental)."
            ),
            inputs=[
                io.Clip.Input("clip"),
                io.String.Input(
                    "prompt",
                    multiline=True,
                    dynamic_prompts=True,
                    tooltip="Positive text instruction for FLUX.2 Klein.",
                ),
                io.Vae.Input(
                    "vae",
                    optional=True,
                    tooltip="Needed only when one or more image references are connected.",
                ),
                io.Autogrow.Input(
                    "images",
                    template=io.Autogrow.TemplateNames(
                        io.Image.Input("image", optional=True),
                        names=[f"image_{index}" for index in range(1, max_images + 1)],
                        min=1,
                    ),
                    optional=True,
                    tooltip=(
                        "Connect image_1 to reveal image_2 and so on. "
                        f"Current configured limit: {max_images}. "
                        "Reference images are processed in socket order."
                    ),
                ),
            ],
            outputs=[
                io.Conditioning.Output(display_name="positive"),
                io.Conditioning.Output(display_name="negative"),
            ],
        )

    @classmethod
    def execute(cls, clip, prompt, vae=None, images: io.Autogrow.Type = None):
        if clip is None:
            raise ValueError("Text Encode Flux Klein: connect a FLUX.2 text encoder to 'clip'.")

        # Native CLIP Text Encode path; encode ONLY the positive instruction.
        positive = clip.encode_from_tokens_scheduled(clip.tokenize(prompt))

        max_images = get_max_images()
        connected_images = []
        for name, image in (images or {}).items():
            if image is None:
                continue
            try:
                index = int(name.rsplit("_", 1)[-1])
            except (ValueError, AttributeError) as exc:
                raise ValueError(f"Text Encode Flux Klein: invalid image socket {name!r}.") from exc
            if not 1 <= index <= max_images or name != f"image_{index}":
                raise ValueError(
                    f"Text Encode Flux Klein: {name!r} exceeds the configured "
                    f"image limit ({max_images}). Update settings.config and restart ComfyUI."
                )
            connected_images.append((index, name, image))

        connected_images.sort(key=lambda item: item[0])
        if connected_images and vae is None:
            raise ValueError(
                "Text Encode Flux Klein: connect a VAE to encode image references. "
                "Leave image sockets unconnected for text-only generation."
            )

        reference_latents = []
        for _, name, image in connected_images:
            try:
                reference_latents.append(vae.encode(image))
            except Exception as exc:
                raise RuntimeError(
                    f"Text Encode Flux Klein: VAE encoding failed for {name}."
                ) from exc

        if reference_latents:
            # The same native mechanism as chained Set Reference Latent nodes.
            positive = node_helpers.conditioning_set_values(
                positive, {"reference_latents": reference_latents}, append=True
            )

        # Critical: call ComfyUI's own ConditioningZeroOut implementation,
        # AFTER references are attached. It zeroes text/pooled conditioning
        # but preserves reference_latents and other non-zeroed metadata.
        from nodes import ConditioningZeroOut

        negative = ConditioningZeroOut().zero_out(positive)[0]
        return io.NodeOutput(positive, negative)
