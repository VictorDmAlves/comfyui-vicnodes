"""VicNodes | Style String Injector v1.0.0.

VicNodes discovers this module via its root modules/ loader. Its node ID
remains identical to the standalone prototype for workflow compatibility.
"""

from .style_injector import StyleStringInjector
from .style_routes import register_routes

VERSION = "1.0.0"

NODE_CLASS_MAPPINGS = {
    "VicStyleStringInjector": StyleStringInjector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VicStyleStringInjector": "Style String Injector",
}

# Routes live on the same URL in both versions, so existing frontend API calls
# and saved workflows keep working. Do not install standalone simultaneously.
register_routes()

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
