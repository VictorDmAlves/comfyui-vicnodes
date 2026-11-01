"""ComfyUI Hybrid Sampler: a compact sampler with optional advanced overrides."""

from .hybrid_sampler import HybridSampler

NODE_CLASS_MAPPINGS = {"HybridSampler": HybridSampler}
NODE_DISPLAY_NAME_MAPPINGS = {"HybridSampler": "Hybrid Sampler"}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
