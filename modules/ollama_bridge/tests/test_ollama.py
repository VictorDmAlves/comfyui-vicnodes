"""Run with: python -m unittest discover -s tests -v (from package root)."""

import base64
import importlib.util
import io
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

import torch
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PKG = "local_ollama_bridge_test"
if PKG not in sys.modules:
    spec = importlib.util.spec_from_file_location(
        PKG, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[PKG] = module
    # Stub the ComfyUI route registration; tests exercise the backend alone.
    import types
    class FakeRoutes:
        def get(self, path):
            return lambda fn: fn
    fake_server = types.ModuleType("server")
    fake_server.PromptServer = types.SimpleNamespace(
        instance=types.SimpleNamespace(routes=FakeRoutes())
    )
    with patch.dict(sys.modules, {"server": fake_server}):
        spec.loader.exec_module(module)

from local_ollama_bridge_test import ollama
from local_ollama_bridge_test.node import OllamaChat


class Handler(BaseHTTPRequestHandler):
    received = []

    def log_message(self, *args):
        pass

    def _send(self, payload, code=200):
        blob = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def do_GET(self):
        if self.path == "/api/tags":
            self._send({"models": [{"name": "vision:latest"}, {"name": "plain:latest"}]})
        elif self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "http://example.org")
            self.end_headers()
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        n = int(self.headers["Content-Length"])
        message = json.loads(self.rfile.read(n))
        self.__class__.received.append(message)
        if message["model"] == "broken":
            self._send({"error": "model not found"}, 404)
        else:
            self._send({"message": {"role": "assistant", "content": "  A sunny street.  "}})


class BridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.http.server_port
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join(timeout=3)

    def setUp(self):
        Handler.received.clear()

    def test_urls(self):
        self.assertEqual(ollama.normalize_url(f"127.0.0.1:{self.port}/"), self.base)
        self.assertEqual(ollama.normalize_url("localhost:11434/api"), "http://localhost:11434")
        for bad in ("http://169.254.169.254", "file:///etc/passwd",
                    "http://localhost:abc", "http://localhost:11434/secret",
                    "http://localhost:11434?url=http://bad", "http://foo@localhost:11434"):
            with self.subTest(bad=bad):
                with self.assertRaises(ollama.OllamaBridgeError):
                    ollama.normalize_url(bad)

    def test_model_list(self):
        self.assertEqual(ollama.get_models(self.base, force=True), ["plain:latest", "vision:latest"])
        self.assertEqual(ollama.get_models(self.base), ["plain:latest", "vision:latest"])

    def test_batched_and_list_images(self):
        one = torch.zeros((1, 24, 32, 3))
        one[0, :, :, 0] = 1
        two = torch.ones((2, 40, 24, 3))
        images = ollama.encode_images([one, two], image_format="JPEG", max_side=28,
                                      quality=85, max_images=3)
        self.assertEqual(len(images), 3)
        raw = base64.b64decode(images[0])
        self.assertTrue(raw.startswith(b"\xff\xd8"))
        opened = Image.open(io.BytesIO(raw))
        self.assertLessEqual(max(opened.size), 28)
        png = ollama.encode_images([one], image_format="PNG", max_side=128,
                                   quality=85, max_images=1)
        self.assertTrue(base64.b64decode(png[0]).startswith(b"\x89PNG"))
        with self.assertRaisesRegex(ollama.OllamaBridgeError, "Max Images"):
            ollama.encode_images([one, two], image_format="PNG", max_side=128,
                                 quality=85, max_images=2)

    def test_chat_payload_and_response(self):
        result = ollama.chat(
            self.base, model="vision:latest", prompt="Describe both", system_prompt="Be precise",
            seed=123, temperature=0.2, max_tokens=80, context_size=2048,
            keep_alive="30m", timeout=5, images=["aW1hZ2U=", "aW1hZ2Uy"], thinking="Disabled"
        )
        self.assertEqual(result, "A sunny street.")
        payload = Handler.received[-1]
        self.assertEqual(payload["messages"][0], {"role": "system", "content": "Be precise"})
        self.assertEqual(len(payload["messages"][1]["images"]), 2)
        self.assertEqual(payload["options"]["seed"], 123)
        self.assertFalse(payload["think"])
        self.assertIs(payload["stream"], False)

    def test_chat_http_error(self):
        with self.assertRaisesRegex(ollama.OllamaBridgeError, "model not found"):
            ollama.chat(self.base, model="broken", prompt="hi", system_prompt="", seed=0,
                        temperature=0, max_tokens=10, context_size=4096,
                        keep_alive="5m", timeout=5, images=[], thinking="Model Default")

    def test_model_validation_with_comfy_list_inputs(self):
        # Regression: ComfyUI calls VALIDATE_INPUTS with list-wrapped widgets
        # when the node declares INPUT_IS_LIST=True.
        for selected in (["vision:latest"], ("vision:latest",), "vision:latest"):
            with self.subTest(selected=selected):
                self.assertIs(OllamaChat.VALIDATE_INPUTS(selected), True)
        for missing in ([], [""], "", ["Click Refresh Models"]):
            with self.subTest(missing=missing):
                self.assertIn("Refresh Models", OllamaChat.VALIDATE_INPUTS(missing))

    def test_is_changed_accepts_all_comfy_input_kwargs(self):
        # Regression for ComfyUI 0.42.1: IS_CHANGED receives every input
        # by keyword, including ollama_url, model, prompt, and images.
        # INPUT_IS_LIST=True can also wrap widget values in lists.
        supplied = {
            "ollama_url": [self.base], "model": ["vision:latest"],
            "prompt": ["Describe it"], "seed": [3],
            "temperature": [0.3], "max_tokens": [1024],
            "context_size": [4096], "system_prompt": ["Output one paragraph"],
            "thinking": ["Disabled"], "keep_alive": ["5m"],
            "image_format": ["JPEG"], "image_max_side": [1024],
            "jpeg_quality": [90], "max_images": [8],
            "timeout_seconds": [300],
            "images": [torch.zeros((1, 8, 8, 3))],
        }
        self.assertEqual(
            OllamaChat.IS_CHANGED(cache_mode=["Cache Identical Inputs"], **supplied),
            "cache",
        )
        self.assertEqual(
            OllamaChat.IS_CHANGED(cache_mode="Cache Identical Inputs", **supplied),
            "cache",
        )
        self.assertTrue(
            OllamaChat.IS_CHANGED(cache_mode=["Always Run"], **supplied)
            != OllamaChat.IS_CHANGED(cache_mode=["Always Run"], **supplied)
        )

    def test_module_import_never_scans_ollama_models(self):
        # Regression: plugin startup must not request /api/tags, even once.
        # Re-execute __init__.py with get_models mocked; no network allowed.
        pkg_module = sys.modules[PKG]
        spec = pkg_module.__spec__
        self.assertIsNotNone(spec)
        import types
        fake_server = types.ModuleType('server')
        fake_routes = types.SimpleNamespace(get=lambda _path: (lambda handler: handler))
        fake_server.PromptServer = types.SimpleNamespace(
            instance=types.SimpleNamespace(routes=fake_routes)
        )
        with patch.dict(sys.modules, {'server': fake_server}), \
                patch.object(ollama, 'get_models', side_effect=AssertionError('Startup scan is forbidden')):
            spec.loader.exec_module(pkg_module)
        # No cached models are required for the module to register normally.
        self.assertIn('OllamaLocalChat', pkg_module.NODE_CLASS_MAPPINGS)

    def test_refresh_node_definitions_is_network_free(self):
        # The ComfyUI R command invokes INPUT_TYPES(). No Ollama HTTP
        # request may run from that path, even if Ollama is unavailable.
        ollama._model_cache.clear()
        with patch.object(ollama, '_request_json', side_effect=AssertionError('Unexpected HTTP request')):
            for _ in range(30):
                options = OllamaChat.INPUT_TYPES()['required']['model'][0]
                self.assertEqual(options, ['Click Refresh Models'])
        ollama.get_models(self.base, force=True)
        with patch.object(ollama, '_request_json', side_effect=AssertionError('Unexpected HTTP request')):
            for _ in range(30):
                # Snapshot is for default URL, not this test server; still no network.
                OllamaChat.INPUT_TYPES()
                self.assertEqual(ollama.get_cached_models(self.base), ['plain:latest', 'vision:latest'])

    def test_node_integration(self):
        kwargs = {
            "ollama_url": [self.base], "model": ["vision:latest"],
            "prompt": ["What is shown?"], "seed": [5],
            "temperature": [0.1], "max_tokens": [60], "context_size": [4096],
            "system_prompt": ["Short response"], "thinking": ["Model Default"],
            "keep_alive": ["5m"], "image_format": ["JPEG"],
            "image_max_side": [1024], "jpeg_quality": [85], "max_images": [8],
            "timeout_seconds": [10], "cache_mode": ["Always Run"],
            "images": [torch.rand((2, 8, 8, 3))],
        }
        self.assertEqual(OllamaChat().run(**kwargs), ("A sunny street.",))
        self.assertEqual(len(Handler.received[-1]["messages"][-1]["images"]), 2)
        self.assertTrue(OllamaChat.IS_CHANGED(["Always Run"]) != OllamaChat.IS_CHANGED(["Always Run"]))
        self.assertEqual(OllamaChat.IS_CHANGED(["Cache Identical Inputs"]), "cache")
        self.assertTrue(OllamaChat.VALIDATE_INPUTS("newly-pulled-model:latest"))


if __name__ == "__main__":
    unittest.main()
