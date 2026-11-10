"""VicNodes Krea 2 Smart Sampler integration (same workflow node ID)."""

from .node import Krea2SmartSampler

# Preserve the exact node ID used by the standalone version.
NODE_CLASS_MAPPINGS = {"VicKrea2SmartSampler": Krea2SmartSampler}
NODE_DISPLAY_NAME_MAPPINGS = {"VicKrea2SmartSampler": "Krea 2 Smart Sampler"}

__version__ = "1.0.3"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "__version__"]
