"""Restricted input/output media upload, preview and download routes for ComfyUI."""

from __future__ import annotations

from pathlib import Path
import re
import uuid

from aiohttp import web
import folder_paths

from .video_core import VIDEO_EXTENSIONS, safe_prefix, secure_file


def locate_media(location, filename, subfolder=""):
    """Resolve a media path while preventing absolute paths, traversal and symlinks outside root."""
    roots = {"input": folder_paths.get_input_directory(),
             "output": folder_paths.get_output_directory(),
             "temp": folder_paths.get_temp_directory()}
    if location not in roots:
        raise ValueError("Invalid media location")
    if not isinstance(filename, str) or not filename or Path(filename).name != filename or "\\" in filename:
        raise ValueError("Invalid media filename")
    if Path(filename).suffix.lower() not in VIDEO_EXTENSIONS:
        raise ValueError("Unsupported video extension")
    subfolder = str(subfolder or "").replace("\\", "/")
    if subfolder.startswith("/") or re.match(r"^[A-Za-z]:", subfolder):
        raise ValueError("Invalid media subfolder")
    parts = [segment for segment in subfolder.split("/") if segment]
    if any(segment in (".", "..") for segment in parts):
        raise ValueError("Invalid media subfolder")
    root = Path(roots[location]).resolve()
    candidate = root.joinpath(*parts, filename).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        raise ValueError("Video not found")
    return candidate


def register_routes():
    from server import PromptServer
    routes = PromptServer.instance.routes

    @routes.get("/vicvideo/preview")
    async def preview(request):
        try:
            path = locate_media(request.query.get("type", "input"),
                                request.query.get("filename", ""),
                                request.query.get("subfolder", ""))
        except ValueError:
            raise web.HTTPNotFound(text="Video not found")
        response = web.FileResponse(path)  # HTTP Range streaming for browser-native playback.
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        # Makes browser's own "Save video as" choose the actual filename.
        response.headers["Content-Disposition"] = f'inline; filename="{path.name}"'
        return response

    @routes.get("/vicvideo/download")
    async def download(request):
        try:
            path = locate_media(request.query.get("type", "output"),
                                request.query.get("filename", ""),
                                request.query.get("subfolder", ""))
        except ValueError:
            raise web.HTTPNotFound(text="Video not found")
        response = web.FileResponse(path)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Disposition"] = f'attachment; filename="{path.name}"'
        return response

    @routes.post("/vicvideo/upload")
    async def upload(request):
        reader = await request.multipart()
        part = await reader.next()
        if part is None or part.name != "video":
            raise web.HTTPBadRequest(text="Expected a video upload")
        filename = Path((part.filename or "").replace("\\", "/")).name
        if Path(filename).suffix.lower() not in VIDEO_EXTENSIONS:
            raise web.HTTPBadRequest(text="Unsupported video extension")
        destination = Path(folder_paths.get_input_directory())
        destination.mkdir(exist_ok=True, parents=True)
        safe_name = safe_prefix(Path(filename).stem) + Path(filename).suffix.lower()
        path = destination / safe_name
        if path.exists():
            path = destination / (safe_prefix(Path(filename).stem) + "_" + uuid.uuid4().hex[:8] + Path(filename).suffix.lower())
        temporary = destination / (".upload_" + uuid.uuid4().hex)
        total = 0
        limit = 3 * 1024 * 1024 * 1024
        try:
            with temporary.open("wb") as stream:
                while True:
                    chunk = await part.read_chunk(size=2**20)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > limit:
                        raise web.HTTPRequestEntityTooLarge(max_size=limit, actual_size=total)
                    stream.write(chunk)
            if total == 0:
                raise web.HTTPBadRequest(text="Empty video upload")
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
        return web.json_response({"name": path.name, "size": total})
