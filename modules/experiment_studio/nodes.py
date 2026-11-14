"""Output capture node for Experiment Studio.

The browser extension creates each job from an API prompt snapshot. This backend
node only saves images using the conventional ComfyUI image output interface.
"""
import os

import numpy as np
from PIL import Image, PngImagePlugin
import folder_paths


class ExperimentStudio:
    CATEGORY = "VicNodes/Experiment Studio"
    FUNCTION = "save_images"
    OUTPUT_NODE = True
    RETURN_TYPES = ()
    DESCRIPTION = (
        "Connect the final IMAGE and use Open Experiment Studio to run "
        "parameter sweeps. Saves results under output/ExperimentStudio/."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "filename_prefix": ("STRING", {"default": "ExperimentStudio"}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    def save_images(self, images, filename_prefix="ExperimentStudio", prompt=None, extra_pnginfo=None):
        # ComfyUI provides path sanitization and ensures the destination is
        # contained within the configured output directory.
        output_dir = folder_paths.get_output_directory()
        width = images[0].shape[1]
        height = images[0].shape[0]
        full_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, output_dir, width, height
        )
        os.makedirs(full_folder, exist_ok=True)
        results = []
        for image in images:
            array = np.clip(255.0 * image.cpu().numpy(), 0, 255).astype(np.uint8)
            img = Image.fromarray(array)
            pnginfo = PngImagePlugin.PngInfo()
            if prompt is not None:
                import json
                pnginfo.add_text("prompt", json.dumps(prompt))
            if extra_pnginfo:
                import json
                for key, value in extra_pnginfo.items():
                    pnginfo.add_text(key, json.dumps(value))
            out_name = f"{filename}_{counter:05}_.png"
            img.save(os.path.join(full_folder, out_name), pnginfo=pnginfo, compress_level=4)
            results.append({"filename": out_name, "subfolder": subfolder, "type": "output"})
            counter += 1
        return {"ui": {"images": results}}


NODE_CLASS_MAPPINGS = {"VicExperimentStudio": ExperimentStudio}
NODE_DISPLAY_NAME_MAPPINGS = {"VicExperimentStudio": "Experiment Studio"}
