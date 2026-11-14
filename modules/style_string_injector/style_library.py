"""Read-only library of filename-paired text prompts and preview images."""

from __future__ import annotations

import hashlib
from pathlib import Path

STYLES_DIR = Path(__file__).resolve().parent / "styles"
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp")
MAX_TEXT_BYTES = 256_000


def _paired_files() -> dict[str, tuple[Path, Path]]:
    """Return validated pairs keyed by their original filename stem."""
    STYLES_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted((p for p in STYLES_DIR.iterdir() if p.is_file()), key=lambda p: p.name.casefold())
    images: dict[str, Path] = {}
    for path in files:
        if path.suffix.lower() in IMAGE_EXTENSIONS:
            images.setdefault(path.stem.casefold(), path)
    pairs: dict[str, tuple[Path, Path]] = {}
    seen: set[str] = set()
    for path in files:
        stem = path.stem
        lookup = stem.casefold()
        if path.suffix.lower() != ".txt" or lookup == "none" or lookup in seen:
            continue
        preview = images.get(lookup)
        if preview is None:
            continue
        if path.stat().st_size > MAX_TEXT_BYTES:
            continue
        seen.add(lookup)
        pairs[stem] = (path, preview)
    return pairs


def list_style_names() -> list[str]:
    return ["None", *sorted(_paired_files(), key=str.casefold)]


def find_style(name: str) -> tuple[Path, Path] | None:
    if not isinstance(name, str) or name.casefold() == "none":
        return None
    # Use the names from the directory scan, never request-supplied paths.
    for style_name, pair in _paired_files().items():
        if style_name == name or style_name.casefold() == name.casefold():
            return pair
    return None


def read_style(name: str) -> str:
    if not name or name.casefold() == "none":
        return ""
    pair = find_style(name)
    if pair is None:
        raise ValueError(f"Style '{name}' was not found. Ensure it has matching .txt and image files in styles/.")
    return pair[0].read_text(encoding="utf-8-sig").strip()


def merged_positive(style: str, inject_position: str, positive: str) -> str:
    positive_text = (positive or "").strip()
    style_text = read_style(style)
    if not style_text:
        return positive_text
    if not positive_text:
        return style_text
    if inject_position == "After":
        return f"{positive_text}\n\n{style_text}"
    return f"{style_text}\n\n{positive_text}"


def style_fingerprint(name: str) -> str:
    if not name or name.casefold() == "none":
        return "none"
    pair = find_style(name)
    if pair is None:
        return f"missing:{name}"
    digest = hashlib.sha256()
    digest.update(pair[0].read_bytes())
    return digest.hexdigest()
