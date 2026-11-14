"""Unified Model Loader module for the VicNodes collection."""

from .unified_model_loader import UnifiedModelLoader

NODE_CLASS_MAPPINGS = {
    "VicUnifiedModelLoader": UnifiedModelLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VicUnifiedModelLoader": "Unified Model Loader",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
