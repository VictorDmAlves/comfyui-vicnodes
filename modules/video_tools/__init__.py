"""VicNodes Video Tools v1.0.0 (module autoloaded by VicNodes)."""

from .video_nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# The VicNodes root already declares WEB_DIRECTORY = "./web".
# Keep our frontend under web/video_tools/video_tools.js (not inside this module).
# Do not override or register a second WEB_DIRECTORY here.
try:
    from .server_routes import register_routes
    register_routes()
except Exception as exc:
    print(f"[Vic Video Tools] Warning: video upload/preview routes unavailable: {exc}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
