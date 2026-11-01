"""Single ComfyUI V1 node for local Ollama chat and vision."""

from __future__ import annotations

from .ollama import (
    DEFAULT_URL, OllamaBridgeError, chat, encode_images, get_cached_models,
)


class OllamaChat:
    """A single prompt-to-text node, optionally grounded in one or more images."""

    CATEGORY = "VicNodes/Ollama Bridge"
    FUNCTION = "run"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("Response",)
    INPUT_IS_LIST = True
    DESCRIPTION = (
        "Run a local Ollama model with a text prompt and optional image batch/list. "
        "Connect Response to any STRING-compatible node. "
        "Use Edit > Ollama: Refresh Models after downloading a new model."
    )

    @classmethod
    def INPUT_TYPES(cls):
        # Read only the cached snapshot. Refresh Node Definitions (R) must
        # NEVER make HTTP requests to Ollama or wait for a model server.
        models = get_cached_models(DEFAULT_URL)
        return {
            "required": {
                "ollama_url": ("STRING", {
                    "default": DEFAULT_URL,
                    "tooltip": "Address of the Ollama service as seen by the ComfyUI backend.",
                }),
                "model": (models or ["Click Refresh Models"], {
                    "tooltip": "Locally downloaded Ollama model. Refresh via ComfyUI Edit > Ollama: Refresh Models.",
                }),
                "prompt": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "dynamicPrompts": False,
                    "tooltip": "Message sent directly to the model. Also accepts images connected below.",
                }),
                "seed": ("INT", {
                    "default": 0, "min": 0, "max": 2147483647,
                    "control_after_generate": True,
                    "tooltip": "Ollama sampling seed. ComfyUI provides fixed/increment/decrement/randomize.",
                }),
                "temperature": ("FLOAT", {
                    "default": 0.7, "min": 0.0, "max": 2.0, "step": 0.05,
                    "tooltip": "Lower is more focused, higher is more varied.",
                }),
                "max_tokens": ("INT", {
                    "default": 512, "min": 1, "max": 16384, "step": 1,
                    "tooltip": "Maximum generated tokens (Ollama num_predict).",
                }),
                "context_size": ("INT", {
                    "default": 4096, "min": 512, "max": 131072, "step": 512,
                    "tooltip": "Context window (Ollama num_ctx). Larger sizes use more memory.",
                    "advanced": True,
                }),
                "system_prompt": ("STRING", {
                    "default": "", "multiline": True,
                    "tooltip": "Optional system instruction; leave blank to use the model's normal behavior.",
                    "advanced": True,
                }),
                "thinking": (["Model Default", "Enabled", "Disabled"], {
                    "tooltip": "Override thinking for models that support Ollama's think option.",
                    "advanced": True,
                }),
                "keep_alive": (["5m", "30m", "1h", "0", "-1"], {
                    "tooltip": "How long Ollama keeps the model in memory. 0 unloads; -1 keeps indefinitely.",
                    "advanced": True,
                }),
                "image_format": (["JPEG", "PNG"], {
                    "tooltip": "JPEG sends less data; PNG preserves exact text and fine details.",
                    "advanced": True,
                }),
                "image_max_side": ("INT", {
                    "default": 1024, "min": 256, "max": 4096, "step": 128,
                    "tooltip": "Resize large reference images before sending them to Ollama.",
                    "advanced": True,
                }),
                "jpeg_quality": ("INT", {
                    "default": 90, "min": 50, "max": 100, "step": 1,
                    "tooltip": "JPEG quality only; ignored in PNG mode.",
                    "advanced": True,
                }),
                "max_images": ("INT", {
                    "default": 8, "min": 1, "max": 32, "step": 1,
                    "tooltip": "Safety limit across all images, including batches and lists.",
                    "advanced": True,
                }),
                "timeout_seconds": ("INT", {
                    "default": 300, "min": 10, "max": 3600, "step": 10,
                    "tooltip": "Maximum wait time for Ollama to generate its answer.",
                    "advanced": True,
                }),
                "cache_mode": (["Cache Identical Inputs", "Always Run"], {
                    "tooltip": "Use ComfyUI caching for speed, or force an Ollama call on every queue.",
                }),
            },
            "optional": {
                "images": ("IMAGE", {
                    "tooltip": "Optional Load Image, IMAGE batch, or IMAGE list. Requires a vision model.",
                }),
            },
        }

    @classmethod
    def VALIDATE_INPUTS(cls, model):
        # INPUT_IS_LIST = True also applies to VALIDATE_INPUTS. ComfyUI wraps
        # widget values in lists (e.g. ["qwen3-vl:4b"]) before passing them
        # here, so checking only isinstance(model, str) rejects valid models.
        # Accept a scalar too for compatibility with direct callers.
        if isinstance(model, (list, tuple)):
            model = model[0] if model else ""
        # Bypass the frozen server-side COMBO enumeration after JS refresh.
        if isinstance(model, str) and model.strip() and model.strip() != "Click Refresh Models":
            return True
        return (
            "No Ollama model selected. Run 'ollama list', check the Ollama URL, "
            "then use Edit > Ollama: Refresh Models and select a model."
        )

    @classmethod
    def IS_CHANGED(cls, cache_mode, **kwargs):
        # ComfyUI supplies all node inputs to IS_CHANGED as named arguments,
        # not just cache_mode. Ignore the extra inputs here; ComfyUI already
        # tracks them in its normal input-based execution cache.
        if isinstance(cache_mode, list):
            cache_mode = cache_mode[0]
        if cache_mode == "Always Run":
            return float("nan")
        return "cache"

    def run(self, ollama_url, model, prompt, seed, temperature, max_tokens,
            context_size, system_prompt, thinking, keep_alive, image_format,
            image_max_side, jpeg_quality, max_images, timeout_seconds,
            cache_mode, images=None):
        # INPUT_IS_LIST also wraps all scalar inputs. Unwrap once.
        def single(values, label):
            if not isinstance(values, list) or not values:
                raise OllamaBridgeError(f"Missing {label} input.")
            return values[0]

        args = {
            "ollama_url": single(ollama_url, "ollama_url"),
            "model": single(model, "model"),
            "prompt": single(prompt, "prompt"),
            "seed": single(seed, "seed"),
            "temperature": single(temperature, "temperature"),
            "max_tokens": single(max_tokens, "max_tokens"),
            "context_size": single(context_size, "context_size"),
            "system_prompt": single(system_prompt, "system_prompt"),
            "thinking": single(thinking, "thinking"),
            "keep_alive": single(keep_alive, "keep_alive"),
            "image_format": single(image_format, "image_format"),
            "image_max_side": single(image_max_side, "image_max_side"),
            "jpeg_quality": single(jpeg_quality, "jpeg_quality"),
            "max_images": single(max_images, "max_images"),
            "timeout_seconds": single(timeout_seconds, "timeout_seconds"),
        }
        encoded = encode_images(
            images or [], image_format=args["image_format"],
            max_side=int(args["image_max_side"]),
            quality=int(args["jpeg_quality"]),
            max_images=int(args["max_images"]),
        )
        answer = chat(
            args["ollama_url"], model=args["model"], prompt=args["prompt"],
            system_prompt=args["system_prompt"], seed=args["seed"],
            temperature=args["temperature"], max_tokens=args["max_tokens"],
            context_size=args["context_size"], keep_alive=args["keep_alive"],
            timeout=int(args["timeout_seconds"]), images=encoded,
            thinking=args["thinking"],
        )
        return (answer,)


NODE_CLASS_MAPPINGS = {"OllamaLocalChat": OllamaChat}
NODE_DISPLAY_NAME_MAPPINGS = {"OllamaLocalChat": "Ollama Chat (Local)"}
