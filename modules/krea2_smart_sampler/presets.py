"""One quality-preset list for the two Krea 2 checkpoints.

Turbo is intended for the distilled Turbo checkpoint (8 steps, CFG 1.0).
Fast/Balanced/Quality use RAW checkpoint settings.
Fast/Balanced/Quality are user-tested RAW presets; their relative quality depends on the prompt and workflow.

The UI writes visible Steps/CFG; the backend never overrides those fields.
"""

PRESETS = {
    "Turbo": (8, 1.0),
    "Fast": (25, 4.5),
    "Balanced": (32, 3.5),
    "Quality": (52, 3.0),
}

MODES = ("Native Reference", "Stage Weighted", "Smooth Warp", "Refined Solver")
PRESET_NAMES = (*PRESETS.keys(), "Custom")


def get_preset(preset: str):
    if preset not in PRESET_NAMES:
        raise ValueError(f"Unknown Krea 2 quality preset: {preset}")
    return PRESETS.get(preset)
