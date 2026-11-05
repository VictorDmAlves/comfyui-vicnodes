"""Visual Compare: lossless temporary previews for classic ComfyUI LiteGraph.

Every frame in each IMAGE batch is published; the browser selects and compares
pairs without running the sampling workflow again. Input tensors are not mutated.
"""

import uuid
from pathlib import Path

import folder_paths
import numpy as np
from PIL import Image


MAX_FRAMES_PER_INPUT = 64


class VisualCompare:
    """Output node for A/B inspection, including independent image batches."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_a": ("IMAGE", {"tooltip": "Original/reference IMAGE or batch of up to 64 frames."}),
                "image_b": ("IMAGE", {"tooltip": "Comparison IMAGE or batch of up to 64 frames."}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "compare"
    OUTPUT_NODE = True
    CATEGORY = "VicNodes/Visual Compare"
    DESCRIPTION = (
        "Compare two IMAGE inputs or batches in the classic LiteGraph UI. "
        "Includes synchronized magnifier, difference heatmap, region focus, "
        "Blink and high-resolution PNG comparison export."
    )

    @staticmethod
    def _validate(tensor, name):
        if tensor.ndim != 4 or tensor.shape[0] < 1 or tensor.shape[-1] not in (3, 4):
            raise ValueError(f"Visual Compare {name} must be a nonempty RGB/RGBA IMAGE batch [B,H,W,C].")
        if tensor.shape[0] > MAX_FRAMES_PER_INPUT:
            raise ValueError(
                f"Visual Compare {name} contains {tensor.shape[0]} frames; "
                f"maximum is {MAX_FRAMES_PER_INPUT} per input to protect disk usage."
            )

    @staticmethod
    def _write_preview(frame, path):
        pixels = np.rint(np.clip(frame.detach().to(device="cpu").float().numpy(), 0.0, 1.0) * 255).astype(np.uint8)
        Image.fromarray(pixels, mode="RGBA" if pixels.shape[-1] == 4 else "RGB").save(
            path, format="PNG", compress_level=1
        )

    def compare(self, image_a, image_b):
        self._validate(image_a, "image_a")
        self._validate(image_b, "image_b")
        temp = Path(folder_paths.get_temp_directory())
        temp.mkdir(parents=True, exist_ok=True)
        token = uuid.uuid4().hex
        entries = {"a_images": [], "b_images": []}
        created = []
        try:
            for key, tensor, label in (("a_images", image_a, "a"), ("b_images", image_b, "b")):
                for i, frame in enumerate(tensor):
                    filename = f"visual_compare_{token}_{label}_{i:03d}.png"
                    path = temp / filename
                    created.append(path)
                    self._write_preview(frame, path)
                    entries[key].append({"filename": filename, "subfolder": "", "type": "temp"})
        except Exception:
            for path in created:
                path.unlink(missing_ok=True)
            raise
        return {"ui": entries}
