"""Load Multi Image (v1.0.7) -- VicNodes module."""
from .load_multi_image import LoadMultiImage

NODE_CLASS_MAPPINGS = {
    "MultiImageLoaderV1": LoadMultiImage,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MultiImageLoaderV1": "Load Multi Image",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
