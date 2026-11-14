"""Unified Model Loader: a small composition of ComfyUI's native loaders.

No model architectures, CLIP recipes, VAE formats, or LoRA patching algorithms
are reimplemented here. This node delegates all those tasks to core nodes.py.
"""

import nodes


class UnifiedModelLoader:
    """Load a diffusion model, one/two text encoders, VAE and up to four LoRAs."""

    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("MODEL", "CLIP", "VAE")
    FUNCTION = "load"
    CATEGORY = "VicNodes/Loaders"
    DESCRIPTION = (
        "Unified native Diffusion Model, Single/Dual CLIP, VAE and four-slot "
        "LoRA loader. LoRAs are applied in ascending slot order with one "
        "strength per slot for both MODEL and CLIP."
    )

    @classmethod
    def INPUT_TYPES(cls):
        # Derive the lists from ComfyUI's installed core nodes so new model
        # types and file formats are picked up without maintaining copies.
        unet = nodes.UNETLoader.INPUT_TYPES()["required"]
        clip = nodes.CLIPLoader.INPUT_TYPES()
        dual_clip = nodes.DualCLIPLoader.INPUT_TYPES()
        vae = nodes.VAELoader.INPUT_TYPES()["required"]
        lora = nodes.LoraLoader.INPUT_TYPES()["required"]

        single_types = list(clip["required"]["type"][0])
        dual_types = list(dual_clip["required"]["type"][0])

        # Prioritize the most common recipes without removing native types.
        single_default = "stable_diffusion"
        dual_default = "flux"
        if single_default in single_types:
            single_types.remove(single_default)
            single_types.insert(0, single_default)
        if dual_default in dual_types:
            dual_types.remove(dual_default)
            dual_types.insert(0, dual_default)

        clip_device = clip.get("optional", {}).get("device")
        if clip_device is None:
            clip_device = dual_clip.get("optional", {}).get(
                "device", (["default", "cpu"], {"advanced": True})
            )

        required = {
            # Diffusion Model
            "model_name": unet["unet_name"],
            "weight_dtype": unet["weight_dtype"],
            # Text encoders
            "clip_mode": (["Single", "Dual"], {
                "tooltip": "Single uses CLIPLoader; Dual uses DualCLIPLoader."
            }),
            "clip_name_1": clip["required"]["clip_name"],
            "clip_name_2": dual_clip["required"]["clip_name2"],
            "clip_type_single": (single_types, {
                "tooltip": "Native CLIPLoader type (used only in Single mode)."
            }),
            "clip_type_dual": (dual_types, {
                "tooltip": "Native DualCLIPLoader type (used only in Dual mode)."
            }),
            "clip_device": clip_device,
            # VAE
            "vae_name": vae["vae_name"],
        }
        native_strength = dict(lora["strength_model"][1])
        native_strength.setdefault("default", 1.0)
        native_strength.setdefault("step", 0.01)
        native_strength["tooltip"] = (
            "LoRA strength applied equally to the diffusion MODEL and CLIP. "
            "Set to 0 or choose None to skip the slot."
        )
        choices = ["None"] + [x for x in lora["lora_name"][0] if x != "None"]
        for i in range(1, 5):
            suffix = f"{i:02d}"
            required[f"lora_{suffix}"] = (choices,)
            required[f"strength_{suffix}"] = ("FLOAT", dict(native_strength))

        return {"required": required}

    def __init__(self):
        # The core LoraLoader already contains a small single-LoRA cache.
        # One native instance per slot keeps its normal cache behavior.
        self._lora_loaders = [nodes.LoraLoader() for _ in range(4)]

    def load(
        self,
        model_name,
        weight_dtype,
        clip_mode,
        clip_name_1,
        clip_name_2,
        clip_type_single,
        clip_type_dual,
        clip_device,
        vae_name,
        lora_01="None",
        strength_01=1.0,
        lora_02="None",
        strength_02=1.0,
        lora_03="None",
        strength_03=1.0,
        lora_04="None",
        strength_04=1.0,
    ):
        # No checkpoint caching or custom weight decoding: use core loaders.
        model = nodes.UNETLoader().load_unet(model_name, weight_dtype)[0]

        if clip_mode == "Single":
            clip = nodes.CLIPLoader().load_clip(
                clip_name_1, clip_type_single, device=clip_device
            )[0]
        elif clip_mode == "Dual":
            if not clip_name_2 or clip_name_2 == "None":
                raise ValueError("Dual CLIP requires clip_name_2.")
            clip = nodes.DualCLIPLoader().load_clip(
                clip_name_1, clip_name_2, clip_type_dual, device=clip_device
            )[0]
        else:
            raise ValueError(f"Unsupported CLIP mode: {clip_mode!r}")

        # VAE stays independent of the LoRAs, as in the original graph.
        vae = nodes.VAELoader().load_vae(vae_name)[0]

        slots = (
            (lora_01, strength_01),
            (lora_02, strength_02),
            (lora_03, strength_03),
            (lora_04, strength_04),
        )
        for loader, (lora_name, strength) in zip(self._lora_loaders, slots):
            if not lora_name or lora_name == "None" or float(strength) == 0.0:
                continue
            model, clip = loader.load_lora(
                model, clip, lora_name, float(strength), float(strength)
            )
        return (model, clip, vae)
