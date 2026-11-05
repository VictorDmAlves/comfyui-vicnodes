"""Visual Compare integration for VicNodes (standalone v1.0.0)."""

from .visual_compare import VisualCompare

# Do not change this identifier: existing workflows use it.
NODE_CLASS_MAPPINGS = {
    "VicVisualCompare": VisualCompare,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VicVisualCompare": "Visual Compare",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
