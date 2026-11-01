"""Spatial LoRA v0.7.1: VicNodes module entrypoint.

VicNodes exposes a single WEB_DIRECTORY='./web'. The UI entrypoint lives in
web/spatial_lora/multi_lora_editor.js outside this Python package.
"""
from .multi_lora import SpatialMultiLoRA

NODE_CLASS_MAPPINGS = {"SpatialMultiLoRA": SpatialMultiLoRA}
NODE_DISPLAY_NAME_MAPPINGS = {"SpatialMultiLoRA": "Spatial LoRA | Multi LoRA"}

CATEGORY_ROOT = "VicNodes/Spatial LoRA"


def _qualify_category(category):
    """Keep optional child paths while placing all future nodes inside VicNodes."""
    if category == CATEGORY_ROOT or category.startswith(CATEGORY_ROOT + "/"):
        return category
    if category == "Spatial LoRA":
        return CATEGORY_ROOT
    if category.startswith("Spatial LoRA/"):
        return CATEGORY_ROOT + category[len("Spatial LoRA"):]
    return CATEGORY_ROOT + ("/" + str(category).strip("/") if category else "")


for _node_class in set(NODE_CLASS_MAPPINGS.values()):
    _node_class.CATEGORY = _qualify_category(getattr(_node_class, "CATEGORY", ""))
del _node_class

# Optional in-memory thumbnail API for connected IMAGE previews (post-execution).
# Keep the original route URL for compatibility with the unchanged editor logic.
from .reference_cache import register_reference_route
register_reference_route()
