"""Text conditioning that delegates its computation to native ComfyUI nodes."""

from __future__ import annotations

from .style_library import list_style_names, merged_positive, style_fingerprint


class StyleStringInjector:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {"tooltip": "CLIP/text encoder for both prompts."}),
                "style": (list_style_names(), {"default": "None", "tooltip": "Choose a paired .txt + image style, or None."}),
                "inject_position": (["Before", "After"], {"default": "Before", "tooltip": "Insert the style before or after the positive prompt."}),
                "positive": ("STRING", {"multiline": True, "default": "", "dynamicPrompts": True, "tooltip": "Positive prompt (style is injected into this field only)."}),
                "negative": ("STRING", {"multiline": True, "default": "", "dynamicPrompts": True, "tooltip": "Negative prompt (never receives an injected style)."}),
            },
            "optional": {
                "preview": ("STRING", {"multiline": True, "default": "", "tooltip": "Read-only combined positive prompt. Managed by the frontend."}),
            }
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("Conditioning Positive", "Conditioning Negative", "Conditioning Zero Out")
    OUTPUT_TOOLTIPS = (
        "Native CLIPTextEncode of positive prompt with optional style.",
        "Native CLIPTextEncode of negative prompt, without style.",
        "Native ConditioningZeroOut applied to positive conditioning.",
    )
    FUNCTION = "encode"
    CATEGORY = "VicNodes/Style String Injector"
    DESCRIPTION = "Select a visual style from text/image pairs, preview the combined prompt, and encode three native conditionings."

    @classmethod
    def IS_CHANGED(cls, style="None", **kwargs):
        """Invalidate the ComfyUI cache if selected style text changes on disk."""
        return style_fingerprint(style)

    def encode(self, clip, style, inject_position, positive, negative, preview=""):
        # Compute again on the server: UI preview is never authoritative.
        from nodes import CLIPTextEncode, ConditioningZeroOut

        final_positive = merged_positive(style, inject_position, positive)
        text_encoder = CLIPTextEncode()
        pos_conditioning = text_encoder.encode(clip, final_positive)[0]
        neg_conditioning = text_encoder.encode(clip, negative or "")[0]
        zero_conditioning = ConditioningZeroOut().zero_out(pos_conditioning)[0]
        return (pos_conditioning, neg_conditioning, zero_conditioning)
