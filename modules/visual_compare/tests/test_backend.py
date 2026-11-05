"""Run with: python -m unittest discover -s tests -v"""
import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path

import torch
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        old = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = types.SimpleNamespace(get_temp_directory=lambda: self.work.name)
        self.addCleanup(self._restore_module, old)
        spec = importlib.util.spec_from_file_location("vc_backend_test", ROOT / "visual_compare.py")
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    @staticmethod
    def _restore_module(old):
        if old is not None:
            sys.modules["folder_paths"] = old
        else:
            sys.modules.pop("folder_paths", None)

    def test_single_and_unique_files(self):
        a = torch.linspace(0, 1, 64 * 48 * 3).reshape(1, 48, 64, 3)
        b = torch.ones((1, 80, 40, 3)) * 0.6
        result = self.module.VisualCompare().compare(a, b)
        for name, size in [("a_images", (64, 48)), ("b_images", (40, 80))]:
            self.assertEqual(len(result["ui"][name]), 1)
            entry = result["ui"][name][0]
            self.assertEqual(entry["type"], "temp")
            with Image.open(Path(self.work.name) / entry["filename"]) as im:
                self.assertEqual(im.size, size)
        another = self.module.VisualCompare().compare(a, b)
        self.assertNotEqual(result["ui"]["a_images"][0]["filename"], another["ui"]["a_images"][0]["filename"])

    def test_all_batch_frames_are_preserved(self):
        a = torch.zeros((3, 8, 8, 3))
        a[0] = 0.2
        a[1] = 0.5
        a[2] = 1
        b = torch.zeros((2, 8, 8, 4))
        b[1] = 1
        entries = self.module.VisualCompare().compare(a, b)["ui"]
        self.assertEqual(len(entries["a_images"]), 3)
        self.assertEqual(len(entries["b_images"]), 2)
        pixels = []
        for entry in entries["a_images"]:
            with Image.open(Path(self.work.name) / entry["filename"]) as im:
                pixels.append(im.getpixel((0, 0)))
        self.assertEqual(pixels, [(51, 51, 51), (128, 128, 128), (255, 255, 255)])
        with Image.open(Path(self.work.name) / entries["b_images"][1]["filename"]) as im:
            self.assertEqual(im.mode, "RGBA")

    def test_invalid_shape_or_oversize_no_leak(self):
        a = torch.zeros((1, 8, 8, 3))
        for bad in [torch.zeros((8, 8, 3)), torch.zeros((65, 8, 8, 3)), torch.zeros((0, 8, 8, 3))]:
            with self.assertRaises(ValueError):
                self.module.VisualCompare().compare(a, bad)
        self.assertEqual(list(Path(self.work.name).iterdir()), [])

    def test_failure_cleans_partial_batch(self):
        a = torch.zeros((3, 8, 8, 3))
        b = torch.zeros((1, 8, 8, 3))
        calls = []
        old = self.module.VisualCompare._write_preview
        def failure(frame, path):
            calls.append(path)
            if len(calls) == 3:
                raise RuntimeError("simulated write error")
            return old(frame, path)
        self.module.VisualCompare._write_preview = staticmethod(failure)
        self.addCleanup(setattr, self.module.VisualCompare, "_write_preview", staticmethod(old))
        with self.assertRaises(RuntimeError):
            self.module.VisualCompare().compare(a, b)
        self.assertEqual(list(Path(self.work.name).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
