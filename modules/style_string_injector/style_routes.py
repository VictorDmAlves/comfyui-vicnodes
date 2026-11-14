"""Local read-only API used by the frontend style gallery."""

from __future__ import annotations

from urllib.parse import quote

from .style_library import _paired_files, find_style, read_style

_registered = False


def register_routes():
    global _registered
    if _registered:
        return
    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes

    @routes.get("/vic_style_injector/styles")
    async def get_styles(request):
        styles = []
        for name in sorted(_paired_files(), key=str.casefold):
            try:
                prompt = read_style(name)
                styles.append({
                    "name": name,
                    "text": prompt,
                    "image_url": f"/vic_style_injector/image/{quote(name, safe='')}",
                })
            except (OSError, UnicodeError, ValueError):
                continue
        response = web.json_response({"styles": styles})
        response.headers["Cache-Control"] = "no-store"
        return response

    @routes.get("/vic_style_injector/image/{name}")
    async def get_style_image(request):
        name = request.match_info.get("name", "")
        pair = find_style(name)
        if pair is None:
            raise web.HTTPNotFound()
        response = web.FileResponse(path=pair[1])
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    _registered = True
