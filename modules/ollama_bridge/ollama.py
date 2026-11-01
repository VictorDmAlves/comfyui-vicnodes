"""Small, dependency-free HTTP client for the Ollama local API."""

from __future__ import annotations

import base64
import io
import json
import os
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from PIL import Image

DEFAULT_URL = "http://localhost:11434"
MODEL_CACHE_SECONDS = 20
_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
_cache_lock = threading.Lock()
_model_cache: dict[str, tuple[float, list[str]]] = {}


class OllamaBridgeError(RuntimeError):
    """An Ollama connection, request, or response failed."""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


# Avoid surprising HTTP proxy behavior and disable redirects. A malicious local
# service must not be able to redirect ComfyUI to an arbitrary destination.
_opener = build_opener(ProxyHandler({}), _NoRedirect())


def normalize_url(raw_url: str) -> str:
    """Accept a base Ollama URL, local-only unless explicitly opted out."""
    raw = str(raw_url or "").strip()
    if not raw:
        raw = DEFAULT_URL
    if "://" not in raw:
        raw = "http://" + raw
    try:
        parsed = urlsplit(raw)
        port = parsed.port  # May raise ValueError for malformed ports.
    except ValueError as exc:
        raise OllamaBridgeError(f"Invalid Ollama URL: {exc}") from exc

    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise OllamaBridgeError("Ollama URL must start with http:// or https://.")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise OllamaBridgeError("Ollama URL cannot include credentials, a query, or a fragment.")
    if parsed.path not in ("", "/", "/api", "/api/"):
        raise OllamaBridgeError("Enter only the Ollama server URL, not an API endpoint.")
    if port is not None and not 1 <= port <= 65535:
        raise OllamaBridgeError("Ollama port must be between 1 and 65535.")
    if os.environ.get("OLLAMA_BRIDGE_ALLOW_REMOTE") != "1":
        if parsed.hostname.lower() not in ("localhost", "127.0.0.1", "::1"):
            raise OllamaBridgeError(
                "Only localhost Ollama URLs are enabled by default. "
                "For a trusted remote server, set OLLAMA_BRIDGE_ALLOW_REMOTE=1 "
                "before starting ComfyUI."
            )
    return f"{parsed.scheme}://{parsed.netloc}"


def _request_json(url: str, *, payload: dict | None = None, timeout: float = 15) -> dict:
    headers = {"Accept": "application/json"}
    body = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(url, headers=headers, data=body, method="POST" if body is not None else "GET")
    try:
        with _opener.open(req, timeout=timeout) as response:
            data = response.read(_MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        detail = exc.read(2048).decode("utf-8", errors="replace")
        try:
            detail = json.loads(detail).get("error", detail)
        except (ValueError, AttributeError):
            pass
        raise OllamaBridgeError(f"Ollama HTTP {exc.code}: {detail}") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise OllamaBridgeError(
            f"Cannot reach Ollama at {url}. Verify Ollama is running and the URL is correct. ({exc})"
        ) from exc
    if len(data) > _MAX_RESPONSE_BYTES:
        raise OllamaBridgeError("Ollama response exceeded the 8 MB safety limit.")
    try:
        parsed = json.loads(data)
    except (ValueError, UnicodeDecodeError) as exc:
        raise OllamaBridgeError("Ollama returned invalid JSON.") from exc
    if not isinstance(parsed, dict):
        raise OllamaBridgeError("Ollama returned an unexpected response format.")
    return parsed


def get_cached_models(raw_url: str = DEFAULT_URL) -> list[str]:
    """Fast, network-free snapshot for INPUT_TYPES and ComfyUI's R action."""
    base = normalize_url(raw_url)
    with _cache_lock:
        cached = _model_cache.get(base)
        return list(cached[1]) if cached else []


def get_models(raw_url: str, *, force: bool = False) -> list[str]:
    base = normalize_url(raw_url)
    with _cache_lock:
        cached = _model_cache.get(base)
        if not force and cached and time.monotonic() - cached[0] < MODEL_CACHE_SECONDS:
            return list(cached[1])
    result = _request_json(f"{base}/api/tags", timeout=2.5)
    items = result.get("models")
    if not isinstance(items, list):
        raise OllamaBridgeError("Ollama /api/tags response does not contain a models list.")
    names = sorted(
        {m["name"] for m in items if isinstance(m, dict) and isinstance(m.get("name"), str) and m["name"]},
        key=str.casefold,
    )
    with _cache_lock:
        _model_cache[base] = (time.monotonic(), names)
    return names


def _encode_tensor(tensor, *, image_format: str, max_side: int, quality: int) -> str:
    """Encode a single ComfyUI HWC IMAGE tensor as base64."""
    if getattr(tensor, "ndim", None) != 3 or tensor.shape[-1] not in (1, 3, 4):
        raise OllamaBridgeError("Expected image tensor with shape [height, width, channels].")
    # ComfyUI tensors are 0..1 float, sometimes resident on the GPU.
    arr = tensor.detach().clamp(0, 1).mul(255).round().byte().cpu().numpy()
    if arr.shape[-1] == 1:
        img = Image.fromarray(arr[:, :, 0], mode="L").convert("RGB")
    elif arr.shape[-1] == 4:
        rgba = Image.fromarray(arr, mode="RGBA")
        img = Image.new("RGB", rgba.size, (255, 255, 255))
        img.paste(rgba, mask=rgba.getchannel("A"))
    else:
        img = Image.fromarray(arr, mode="RGB")
    if max(img.size) > max_side:
        img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    if image_format == "PNG":
        img.save(out, format="PNG", optimize=True)
    else:
        img.save(out, format="JPEG", quality=quality, optimize=True)
    return base64.b64encode(out.getvalue()).decode("ascii")


def encode_images(image_batches: list, *, image_format: str, max_side: int,
                  quality: int, max_images: int) -> list[str]:
    """Flatten all ComfyUI list entries AND the batch dimension of each IMAGE."""
    batches = [item for item in (image_batches or []) if item is not None]
    total = 0
    for batch in batches:
        if getattr(batch, "ndim", None) != 4:
            raise OllamaBridgeError("The images input expects ComfyUI IMAGE batches [B,H,W,C].")
        total += int(batch.shape[0])
    if total > max_images:
        raise OllamaBridgeError(
            f"Received {total} images, but Max Images is {max_images}. "
            "Increase Max Images or reduce the input batch/list."
        )
    images = []
    for batch in batches:
        for item in batch:
            images.append(_encode_tensor(item, image_format=image_format,
                                         max_side=max_side, quality=quality))
    return images


def chat(raw_url: str, *, model: str, prompt: str, system_prompt: str, seed: int,
         temperature: float, max_tokens: int, context_size: int, keep_alive: str,
         timeout: int, images: list[str], thinking: str) -> str:
    base = normalize_url(raw_url)
    model = str(model).strip()
    if not model or model.startswith("Click Refresh"):
        raise OllamaBridgeError("Choose a downloaded model. Use Refresh Models if the list is empty.")
    if not prompt.strip() and not images:
        raise OllamaBridgeError("Provide a prompt and/or connect an image.")
    messages = []
    if system_prompt.strip():
        messages.append({"role": "system", "content": system_prompt.strip()})
    user_message = {"role": "user", "content": prompt if prompt.strip() else "Describe the attached image(s)."}
    if images:
        user_message["images"] = images
    messages.append(user_message)
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "keep_alive": keep_alive,
        "options": {
            "seed": int(seed),
            "temperature": float(temperature),
            "num_predict": int(max_tokens),
            "num_ctx": int(context_size),
        },
    }
    if thinking != "Model Default":
        payload["think"] = thinking == "Enabled"
    response = _request_json(f"{base}/api/chat", payload=payload, timeout=timeout)
    message = response.get("message")
    if not isinstance(message, dict):
        raise OllamaBridgeError("Ollama returned no chat message.")
    content = message.get("content")
    if not isinstance(content, str):
        raise OllamaBridgeError("Ollama returned no text content.")
    if not content.strip() and message.get("thinking"):
        raise OllamaBridgeError(
            "The model returned thinking text but no final answer. "
            "Try increasing Max Tokens or disabling Thinking."
        )
    return content.strip()
