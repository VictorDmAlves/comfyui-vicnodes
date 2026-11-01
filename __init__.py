
import importlib
import logging
from pathlib import Path

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

ROOT = Path(__file__).resolve().parent
MODULES_DIR = ROOT / "modules"
WEB_DIRECTORY = "./web"

logger = logging.getLogger("VicNodes")

if MODULES_DIR.is_dir():
    for folder in sorted(MODULES_DIR.iterdir()):
        if not folder.is_dir():
            continue

        if not (folder / "__init__.py").is_file():
            continue

        module_name = folder.name

        try:
            module = importlib.import_module(
                f".modules.{module_name}",
                package=__name__
            )

            classes = getattr(module, "NODE_CLASS_MAPPINGS", {})
            display_names = getattr(
                module, "NODE_DISPLAY_NAME_MAPPINGS", {}
            )

            if not isinstance(classes, dict) or not classes:
                logger.warning(
                    "[VicNodes] No nodes found in %s", module_name
                )
                continue

            conflicts = set(classes) & set(NODE_CLASS_MAPPINGS)

            if conflicts:
                logger.error(
                    "[VicNodes] Duplicate node IDs in %s: %s",
                    module_name, sorted(conflicts)
                )
                continue

            NODE_CLASS_MAPPINGS.update(classes)
            NODE_DISPLAY_NAME_MAPPINGS.update(display_names)

            logger.info(
                "[VicNodes] Loaded %s (%d nodes)",
                module_name, len(classes)
            )

        except Exception:
            logger.exception(
                "[VicNodes] Failed to load %s", module_name
            )

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
