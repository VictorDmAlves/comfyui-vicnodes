"""Fast Groups Control metadata for the VicNodes Python module loader.

The two controls are JavaScript/LiteGraph virtual nodes. No backend execution
classes are created or needed. The root loader can report this module in the
ComfyUI terminal using FRONTEND_ONLY_NODES after the opt-in loader patch.
"""

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
FRONTEND_ONLY_NODES = (
    "Fast Groups Control - Bypasser",
    "Fast Groups Control - Muter",
)
