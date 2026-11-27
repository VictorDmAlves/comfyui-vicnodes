"""Node Follow Path v1.0 - VicNodes frontend-only module.

Loaded via the parent VicNodes WEB_DIRECTORY = "./web".
No processing nodes or Python execution hooks are registered.
"""

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
# The VicNodes root loader recognizes frontend-only modules through this marker.
# No Python execution node is registered; the extension is loaded from WEB_DIRECTORY.
FRONTEND_ONLY_NODES = ("Node Follow Path",)
FRONTEND_ONLY_EXTENSION = "VicNodes.NodeFollowPath"
