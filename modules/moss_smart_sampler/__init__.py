"""ComfyUI MOSS Smart Sampler: single-node experimental sigma scheduling."""

from .nodes import MOSSSmartSampler

NODE_CLASS_MAPPINGS = {"MOSSSmartSampler": MOSSSmartSampler}
NODE_DISPLAY_NAME_MAPPINGS = {"MOSSSmartSampler": "MOSS Smart Sampler"}
__version__ = "1.1.0"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "__version__"]
