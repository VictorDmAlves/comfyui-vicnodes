"""Mocked contract tests for the FLUX.2 Klein standalone extension.

No ComfyUI, torch or GPU required. The ConditioningZeroOut stub mirrors the
native nodes.py implementation (copy metadata, zero known tensor fields,
retain non-zeroed metadata such as reference_latents).
"""

import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class FakeTensor:
    def __init__(self, values):
        self.values = tuple(values)

    def zero(self):
        return FakeTensor([0] * len(self.values))

    def __eq__(self, other):
        return isinstance(other, FakeTensor) and self.values == other.values

    def __repr__(self):
        return f"FakeTensor({self.values})"


class ZeroOutStub:
    calls = 0

    def zero_out(self, conditioning):
        ZeroOutStub.calls += 1
        c = []
        for tensor, metadata in conditioning:
            d = metadata.copy()
            for key in (
                "pooled_output", "conditioning_lyrics", "conditioning_scale", "direct_context"
            ):
                if d.get(key) is not None:
                    d[key] = d[key].zero()
            c.append([tensor.zero(), d])
        return (c,)


def install_comfy_stub():
    comfy_api = types.ModuleType("comfy_api")
    latest = types.ModuleType("comfy_api.latest")

    class ComfyExtension:
        pass

    class NodeOutput(tuple):
        def __new__(cls, *values):
            return tuple.__new__(cls, values)

    class BaseInput:
        @classmethod
        def Input(cls, name, **kwargs):
            return {"type": cls.__name__, "name": name, **kwargs}

        @classmethod
        def Output(cls, **kwargs):
            return {"type": cls.__name__, **kwargs}

    class Clip(BaseInput):
        pass

    class String(BaseInput):
        pass

    class Vae(BaseInput):
        pass

    class Image(BaseInput):
        pass

    class Conditioning(BaseInput):
        pass

    class Autogrow(BaseInput):
        Type = dict

        @staticmethod
        def TemplateNames(input_def, names, min=0):
            return {"input_def": input_def, "names": names, "min": min}

    class IO:
        ComfyNode = type("ComfyNode", (), {})
        Schema = staticmethod(lambda **kwargs: kwargs)

    IO.NodeOutput = NodeOutput
    IO.Clip = Clip
    IO.String = String
    IO.Vae = Vae
    IO.Image = Image
    IO.Autogrow = Autogrow
    IO.Conditioning = Conditioning
    latest.ComfyExtension = ComfyExtension
    latest.io = IO
    comfy_api.latest = latest

    helpers = types.ModuleType("node_helpers")

    def conditioning_set_values(conditioning, values, append=False):
        result = []
        for tensor, metadata in conditioning:
            updated = metadata.copy()
            for key, value in values.items():
                if append and key in updated:
                    value = updated[key] + value
                updated[key] = value
            result.append([tensor, updated])
        return result

    helpers.conditioning_set_values = conditioning_set_values

    nodes = types.ModuleType("nodes")
    nodes.ConditioningZeroOut = ZeroOutStub

    sys.modules["comfy_api"] = comfy_api
    sys.modules["comfy_api.latest"] = latest
    sys.modules["node_helpers"] = helpers
    sys.modules["nodes"] = nodes


install_comfy_stub()
spec = importlib.util.spec_from_file_location(
    "flux_klein_text_encode_test_pkg",
    ROOT / "__init__.py",
    submodule_search_locations=[str(ROOT)],
)
package = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = package
spec.loader.exec_module(package)
FluxKleinTextEncode = package.FluxKleinTextEncode
encoder_module = sys.modules[f"{spec.name}.flux_klein_text_encode"]


class FakeCLIP:
    def __init__(self):
        self.tokenized = []

    def tokenize(self, text):
        self.tokenized.append(text)
        return ("tokens", text)

    def encode_from_tokens_scheduled(self, tokens):
        return [
            [FakeTensor([1, 2]), {
                "pooled_output": FakeTensor([3, 4]),
                "conditioning_lyrics": FakeTensor([5]),
                "conditioning_scale": FakeTensor([6]),
                "direct_context": FakeTensor([7]),
                "existing_setting": "retained",
            }]
        ]


class FakeVAE:
    def __init__(self):
        self.encoded = []

    def encode(self, image):
        self.encoded.append(image)
        return f"latent_{image}"


class TestNode(unittest.TestCase):
    def setUp(self):
        ZeroOutStub.calls = 0

    def test_schema_default_and_name(self):
        schema = FluxKleinTextEncode.define_schema()
        self.assertEqual(schema["node_id"], "VicFluxKleinTextEncode")
        self.assertEqual(schema["display_name"], "Text Encode Flux Klein")
        self.assertEqual(schema["category"], "VicNodes/Flux Klein Text Encode")
        self.assertEqual(len(schema["outputs"]), 2)
        inputs = schema["inputs"]
        self.assertEqual([x["name"] for x in inputs[:3]], ["clip", "prompt", "vae"])
        self.assertFalse(any(x["name"] == "negative_prompt" for x in inputs))
        self.assertFalse(any(x["name"] == "resolution" for x in inputs))
        autogrow = next(x for x in inputs if x["name"] == "images")
        self.assertEqual(autogrow["template"]["names"], [f"image_{n}" for n in range(1, 5)])
        self.assertEqual(autogrow["template"]["min"], 1)

    def test_text_only_zero_out_not_empty_prompt(self):
        clip = FakeCLIP()
        positive, negative = FluxKleinTextEncode.execute(clip, "hi")
        self.assertEqual(clip.tokenized, ["hi"])
        self.assertEqual(ZeroOutStub.calls, 1)
        self.assertEqual(positive[0][0], FakeTensor([1, 2]))
        self.assertEqual(negative[0][0], FakeTensor([0, 0]))
        self.assertEqual(positive[0][1]["pooled_output"], FakeTensor([3, 4]))
        self.assertEqual(negative[0][1]["pooled_output"], FakeTensor([0, 0]))
        for key in ("conditioning_lyrics", "conditioning_scale", "direct_context"):
            self.assertEqual(negative[0][1][key], FakeTensor([0]))
        self.assertNotIn("reference_latents", negative[0][1])
        self.assertEqual(positive[0][1]["existing_setting"], "retained")
        self.assertEqual(negative[0][1]["existing_setting"], "retained")
        self.assertIsNot(positive[0][1], negative[0][1])

    def test_references_ordered_and_preserved_in_zeroed_negative(self):
        clip, vae = FakeCLIP(), FakeVAE()
        positive, negative = FluxKleinTextEncode.execute(
            clip, "scene", vae=vae,
            images={"image_4": "D", "image_2": "B", "image_1": "A", "image_3": None},
        )
        self.assertEqual(vae.encoded, ["A", "B", "D"])
        self.assertEqual(clip.tokenized, ["scene"])
        for cond in (positive, negative):
            self.assertEqual(cond[0][1]["reference_latents"], ["latent_A", "latent_B", "latent_D"])
            self.assertEqual(cond[0][1]["existing_setting"], "retained")
        self.assertIs(positive[0][1]["reference_latents"], negative[0][1]["reference_latents"])
        self.assertEqual(negative[0][0], FakeTensor([0, 0]))
        self.assertEqual(ZeroOutStub.calls, 1)

    def test_missing_vae_raises(self):
        with self.assertRaisesRegex(ValueError, "connect a VAE"):
            FluxKleinTextEncode.execute(FakeCLIP(), "p", images={"image_1": "A"})

    def test_empty_sockets_do_not_require_vae(self):
        p, n = FluxKleinTextEncode.execute(FakeCLIP(), "p", images={"image_1": None})
        self.assertNotIn("reference_latents", p[0][1])
        self.assertNotIn("reference_latents", n[0][1])

    def test_reject_above_default_limit(self):
        with self.assertRaisesRegex(ValueError, "configured image limit \\(4\\)"):
            FluxKleinTextEncode.execute(FakeCLIP(), "p", vae=FakeVAE(), images={"image_5": "X"})

    def test_config_override_ten(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = Path(td) / "settings.config"
            cfg.write_text("[references]\nmax_images = 10\n", encoding="utf-8")
            with patch.object(encoder_module, "CONFIG_PATH", cfg):
                schema = FluxKleinTextEncode.define_schema()
                names = next(x for x in schema["inputs"] if x["name"] == "images")["template"]["names"]
                self.assertEqual(len(names), 10)
                self.assertEqual(names[-1], "image_10")
                p, n = FluxKleinTextEncode.execute(
                    FakeCLIP(), "p", vae=FakeVAE(), images={"image_10": "X"}
                )
                self.assertEqual(p[0][1]["reference_latents"], ["latent_X"])
                self.assertEqual(n[0][1]["reference_latents"], ["latent_X"])

    def test_config_override_one(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = Path(td) / "settings.config"
            cfg.write_text("[references]\nmax_images = 1\n", encoding="utf-8")
            with patch.object(encoder_module, "CONFIG_PATH", cfg):
                self.assertEqual(encoder_module.get_max_images(), 1)
                schema = FluxKleinTextEncode.define_schema()
                names = next(x for x in schema["inputs"] if x["name"] == "images")["template"]["names"]
                self.assertEqual(names, ["image_1"])

    def test_bad_config_defaults_to_four(self):
        with tempfile.TemporaryDirectory() as td:
            cfg = Path(td) / "settings.config"
            with patch.object(encoder_module, "CONFIG_PATH", cfg):
                self.assertEqual(encoder_module.get_max_images(), 4)
                for value in ("999", "0", "not_a_number"):
                    cfg.write_text(f"[references]\nmax_images = {value}\n", encoding="utf-8")
                    self.assertEqual(encoder_module.get_max_images(), 4)
                cfg.write_text("invalid ini", encoding="utf-8")
                self.assertEqual(encoder_module.get_max_images(), 4)

    def test_vicnodes_module_registration(self):
        self.assertEqual(package.NODE_CLASS_MAPPINGS, {"VicFluxKleinTextEncode": FluxKleinTextEncode})
        self.assertEqual(package.NODE_DISPLAY_NAME_MAPPINGS, {"VicFluxKleinTextEncode": "Text Encode Flux Klein"})


if __name__ == "__main__":
    unittest.main()
