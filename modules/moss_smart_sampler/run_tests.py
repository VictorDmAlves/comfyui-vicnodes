"""Run offline tests from a temporary directory without importing ComfyUI."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


if __name__ == "__main__":
    source = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory(prefix="moss_smart_tests_") as temporary:
        tests = Path(temporary) / "tests"
        shutil.copytree(source / "tests", tests, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
        env = dict(os.environ, MOSS_PLUGIN_SOURCE=str(source))
        code = subprocess.call([sys.executable, "-m", "pytest", "-q", str(tests)],
                               cwd=temporary, env=env)
    sys.exit(code)
