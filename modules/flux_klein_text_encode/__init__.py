"""VicNodes module registration for FLUX.2 Klein Text Encode (ComfyUI V3 node)."""

from .flux_klein_text_encode import FluxKleinTextEncode

# VicNodes' existing root __init__.py autodiscovers modules exposing these mappings.
# ComfyUI registers V3 io.ComfyNode classes in the same global node-class map.
NODE_CLASS_MAPPINGS = {
    "VicFluxKleinTextEncode": FluxKleinTextEncode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VicFluxKleinTextEncode": "Text Encode Flux Klein",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
