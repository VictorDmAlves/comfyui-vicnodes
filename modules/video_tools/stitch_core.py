"""File-based video stitching for ComfyUI Video Tools. No VHS dependency."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import subprocess
import uuid
from fractions import Fraction

from .video_core import VIDEO_EXTENSIONS, ffmpeg_path, ffprobe_path, run_checked, encoder_args, even


def resolve_video_source(value, roots):
    """Only accept paths inside ComfyUI input/output/temp trees, including symlinks."""
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise ValueError("Video Stitch received an invalid video path")
    raw = value.strip().strip('"')
    roots = {name: Path(path).resolve() for name, path in roots.items()}
    match = re.match(r"^(input|output|temp):(.+)$", raw, re.I)
    label = match.group(1).lower() if match else None
    if match:
        raw = match.group(2).strip()
        if raw.startswith(("/", "\\")) or re.match(r"^[a-zA-Z]:", raw):
            raise ValueError("A prefixed video path must be relative")
    elif raw.startswith("\\\\"):
        raise ValueError("Network media paths are not allowed")
    normalized = raw.replace("\\", "/")
    if any(part in (".", "..") for part in normalized.split("/")):
        raise ValueError("Video Stitch forbids path traversal")
    path = Path(raw)
    if path.is_absolute():
        candidates = [path.resolve()]
    else:
        relative = Path(normalized)
        candidates = [(roots[label] / relative).resolve()] if label else [
            (roots[key] / relative).resolve() for key in ("output", "input", "temp") if key in roots]
    for candidate in candidates:
        if (candidate.suffix.lower() in VIDEO_EXTENSIONS and candidate.is_file()
                and any(candidate.is_relative_to(root) for root in roots.values())):
            return candidate
    raise ValueError(f"Video Stitch file not found within ComfyUI media folders: {value}")


def stitch_video_info(path):
    data = json.loads(run_checked([
        ffprobe_path(), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)
    ]).stdout)
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    if video is None:
        raise ValueError(f"No video stream in {Path(path).name}")
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    try:
        fps = float(Fraction(video.get("avg_frame_rate") or video.get("r_frame_rate") or "0/1"))
    except (ValueError, TypeError, ZeroDivisionError):
        fps = 0
    if fps <= 0 or not math.isfinite(fps):
        fps = 24.0
    try:
        frames = int(video.get("nb_frames") or 0)
    except (TypeError, ValueError):
        frames = 0
    duration = float(video.get("duration") or data.get("format", {}).get("duration") or 0)
    if not math.isfinite(duration) or duration <= 0:
        duration = frames / fps if frames else 0.001
    return {"video": video, "audio": audio, "fps": fps, "frames": frames,
            "duration": duration, "width": int(video["width"]), "height": int(video["height"])}


def copy_compatible(infos, audio_mode):
    video_fields = ("codec_name", "profile", "level", "width", "height", "pix_fmt",
                    "time_base", "avg_frame_rate", "r_frame_rate", "sample_aspect_ratio",
                    "field_order", "color_range", "color_space", "color_primaries", "color_transfer")
    audio_fields = ("codec_name", "profile", "sample_rate", "channels", "channel_layout", "time_base")
    for index, current in enumerate(infos[1:], 2):
        for key in video_fields:
            if current["video"].get(key) != infos[0]["video"].get(key):
                return False, f"clip {index} has different video {key}"
        if audio_mode == "Auto":
            if bool(current["audio"]) != bool(infos[0]["audio"]):
                return False, f"clip {index} has different audio presence"
            if current["audio"]:
                for key in audio_fields:
                    if current["audio"].get(key) != infos[0]["audio"].get(key):
                        return False, f"clip {index} has different audio {key}"
    return True, "matching streams"


def write_concat_file(paths, path):
    lines = ["ffconcat version 1.0"]
    for item in paths:
        escaped = str(item.resolve()).replace("\\", "/").replace("'", "'\\''")
        lines.append(f"file '{escaped}'")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _boundary_gray(path, last, info):
    """Decode only a short tail/head into one tiny luminance frame (never an IMAGE batch)."""
    size = 64 * 64
    command = [ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-nostdin"]
    if last:
        # Seeking near EOF avoids decoding the entire clip. Allow room for the
        # last presentation frame, even for the shortest supported clips.
        seek = min(1.0, max(0.05, info["duration"] - (0.5 / info["fps"])))
        command += ["-sseof", f"-{seek:.6f}"]
    command += ["-i", str(path), "-map", "0:v:0", "-an", "-sn", "-dn",
                "-vf", "scale=64:64,format=gray"]
    if not last:
        command += ["-frames:v", "1"]
    command += ["-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]
    raw = run_checked(command).stdout
    if len(raw) < size or len(raw) % size:
        raise RuntimeError(f"Could not decode the video boundary frame: {Path(path).name}")
    return raw[-size:] if last else raw[:size]


def detect_duplicate_seams(paths, infos, threshold):
    """Return per-boundary decisions and normalized gray MAE scores.

    Small decoded 64x64 gray frames are compared rather than source packets:
    compressed video may have different bytes despite identical imagery.
    Strict detection avoids discarding a moving frame merely because the
    composition is similar. The threshold is intentionally user-adjustable.
    """
    comparisons = []
    # Caching a boundary prevents decoding the same intermediate clip twice.
    first_frames = [_boundary_gray(p, False, i) for p, i in zip(paths[1:], infos[1:])]
    last_frames = [_boundary_gray(p, True, i) for p, i in zip(paths[:-1], infos[:-1])]
    for before, after in zip(last_frames, first_frames):
        mae = sum(abs(x-y) for x, y in zip(before, after)) / (len(before)*255.0)
        comparisons.append((mae <= threshold, mae))
    return comparisons


def _frame_count_at_fps(info, fps):
    if info["frames"] and abs(info["fps"] - fps) < 0.0001:
        return info["frames"]
    # Expected CFR frame count after fps filtering. Fractional stream durations
    # are normalized to an integer output frame cadence.
    return max(1, round(info["duration"] * fps))


def reencode(paths, infos, dest, fps, encoder, container, quality, pix_fmt, preset, audio_mode,
             seam_mode="Cut", duplicates=None, crossfade_seconds=0.35):
    width, height = even(infos[0]["width"]), even(infos[0]["height"])
    want_audio = audio_mode == "Auto" and any(info["audio"] is not None for info in infos)
    filters, video_labels, audio_labels = [], [], []
    duplicate_flags = duplicates if seam_mode == "Remove Duplicate" else None
    overlap_frames = max(1, round(crossfade_seconds * fps)) if seam_mode == "Crossfade" else 0
    segment_counts = [_frame_count_at_fps(info, fps) for info in infos]
    if seam_mode == "Crossfade":
        # xfade needs at least one non-transition frame on both sides.
        for index, count in enumerate(segment_counts):
            if count <= overlap_frames + 1:
                raise ValueError(
                    f"Crossfade {crossfade_seconds:g}s is too long for clip {index + 1} "
                    f"({count} frames at {fps:g} FPS). Use a shorter transition."
                )
    for index, info in enumerate(infos):
        drop_first = int(bool(duplicate_flags and index and duplicate_flags[index-1]))
        frames = segment_counts[index] - drop_first
        if frames < 1:
            raise ValueError(f"Clip {index+1} would become empty after duplicate removal")
        trim_filter = ",trim=start_frame=1" if drop_first else ""
        filters.append(f"[{index}:v:0]fps={fps:.9g},"
                       f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
                       f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p"
                       f"{trim_filter},settb=AVTB,setpts=N/({fps:.9g}*TB),fps={fps:.9g}[v{index}]")
        video_labels.append(f"[v{index}]")
        if want_audio:
            # Align audio with the *normalized* video timeline. When a boundary
            # frame is dropped, trim precisely one output-frame period of the
            # following clip's audio too, preventing A/V drift.
            duration = frames / fps
            skip = drop_first / fps
            audio_filter = (f"[{index}:a:0]aresample=48000,"
                            "aformat=sample_fmts=fltp:channel_layouts=stereo") if info["audio"] else (
                            "anullsrc=r=48000:cl=stereo")
            if skip:
                audio_filter += f",atrim=start={skip:.9f},asetpts=PTS-STARTPTS"
            audio_filter += f",apad,atrim=duration={duration:.9f},asetpts=PTS-STARTPTS[a{index}]"
            filters.append(audio_filter)
            audio_labels.append(f"[a{index}]")
    if seam_mode == "Crossfade":
        # xfade inputs use identical sizes, timebase, FPS and pixel format.
        # Count frames, rather than summing unrounded durations, to ensure each
        # multi-clip transition starts at a stable frame boundary.
        current = "v0"
        timeline_frames = segment_counts[0]
        overlap = overlap_frames / fps
        for index in range(1, len(paths)):
            offset = (timeline_frames - overlap_frames) / fps
            output = f"vx{index}"
            filters.append(f"[{current}][v{index}]xfade=transition=fade:"
                           f"duration={overlap:.9f}:offset={offset:.9f}[{output}]")
            current = output
            timeline_frames += segment_counts[index] - overlap_frames
        filters.append(f"[{current}]format=yuv420p[vout]")
        if want_audio:
            current = "a0"
            for index in range(1, len(paths)):
                output = f"ax{index}"
                filters.append(f"[{current}][a{index}]acrossfade=d={overlap:.9f}:"
                               f"c1=tri:c2=tri[{output}]")
                current = output
            filters.append(f"[{current}]anull[aout]")
    else:
        filters.append("".join(video_labels) + f"concat=n={len(paths)}:v=1:a=0[vout]")
        if want_audio:
            filters.append("".join(audio_labels) + f"concat=n={len(paths)}:v=0:a=1[aout]")
    command = [ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error", "-nostdin"]
    for item in paths:
        command.extend(["-i", str(item)])
    command.extend(["-filter_complex", ";".join(filters), "-map", "[vout]"])
    command.extend(["-map", "[aout]"] if want_audio else ["-an"])
    command.extend(encoder_args(encoder, container, quality, pix_fmt, preset))
    if want_audio:
        command.extend(["-c:a", "libopus" if container == "webm" else "aac", "-b:a", "192k"])
    command.extend(["-r", f"{fps:.9g}", "-fps_mode", "cfr"])
    if container == "mp4":
        command.extend(["-movflags", "+faststart"])
    run_checked(command + [str(dest)])


def stitch_videos(paths, destination, stitch_mode="Auto", audio_mode="Auto",
                  encoder="H.264 CPU", container="mp4", quality=18,
                  pix_fmt="yuv420p", preset="medium", target_fps=0,
                  seam_mode="Cut", crossfade_seconds=0.35, duplicate_threshold=0.02):
    paths = [Path(item).resolve() for item in paths]
    if not 2 <= len(paths) <= 16:
        raise ValueError("Video Stitch supports 2 to 16 input clips")
    if stitch_mode not in ("Auto", "Copy", "Re-encode") or audio_mode not in ("Auto", "Mute"):
        raise ValueError("Unknown Stitch mode")
    if seam_mode not in ("Cut", "Remove Duplicate", "Crossfade"):
        raise ValueError("Unknown Seam mode")
    if not math.isfinite(crossfade_seconds) or not 0.04 <= crossfade_seconds <= 3:
        raise ValueError("Crossfade seconds must be 0.04–3.0")
    if not math.isfinite(duplicate_threshold) or not 0 <= duplicate_threshold <= 0.15:
        raise ValueError("Duplicate threshold must be between 0 and 0.15")
    if container not in ("mp4", "mkv", "webm"):
        raise ValueError("Use MP4, MKV, or WebM for Stitch output")
    for item in paths:
        if not item.is_file() or item.suffix.lower() not in VIDEO_EXTENSIONS:
            raise ValueError(f"Invalid Stitch input: {item}")
    infos = [stitch_video_info(item) for item in paths]
    if target_fps and (not math.isfinite(target_fps) or not 0 < target_fps <= 240):
        raise ValueError("Invalid target FPS")
    fps = float(target_fps) if target_fps else infos[0]["fps"]
    compatible, why = copy_compatible(infos, audio_mode)
    if target_fps and abs(fps - infos[0]["fps"]) > .001:
        compatible, why = False, "requested FPS differs from clip FPS"

    duplicates = None
    if seam_mode == "Crossfade":
        # Overlapping/merging two decoded frames is impossible in stream-copy mode.
        compatible, why = False, "Crossfade requires decoding and re-encoding"
    elif seam_mode == "Remove Duplicate":
        comparisons = detect_duplicate_seams(paths, infos, duplicate_threshold)
        duplicates = [matched for matched, _ in comparisons]
        for index, (matched, score) in enumerate(comparisons, 1):
            print(f"[Vic Video Tools] Seam {index}: difference={score:.4f}, "
                  f"threshold={duplicate_threshold:.4f}, "
                  f"{'remove first frame' if matched else 'keep both frames'}")
        if any(duplicates):
            compatible, why = False, "matched seam frames require accurate frame removal"
    if stitch_mode == "Copy" and not compatible:
        raise ValueError(f"Cannot use direct Copy: {why}; choose Auto or Re-encode")
    dest = Path(destination)
    textfile = dest.parent / f".vicstitch_{uuid.uuid4().hex}.ffconcat"
    method = "Copy" if compatible and stitch_mode != "Re-encode" else "Re-encode"
    try:
        if method == "Copy":
            write_concat_file(paths, textfile)
            command = [ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
                       "-f", "concat", "-safe", "0", "-i", str(textfile), "-map", "0:v:0"]
            command.extend(["-map", "0:a:0", "-c", "copy"] if audio_mode == "Auto" and infos[0]["audio"]
                           else ["-an", "-c:v", "copy"])
            if container == "mp4":
                command.extend(["-movflags", "+faststart"])
            try:
                run_checked(command + [str(dest)])
            except RuntimeError:
                dest.unlink(missing_ok=True)
                if stitch_mode == "Copy":
                    raise
                method = "Re-encode"
        if method == "Re-encode":
            reencode(paths, infos, dest, fps, encoder, container, quality, pix_fmt, preset,
                     audio_mode, seam_mode, duplicates, crossfade_seconds)
        result = stitch_video_info(dest)
        return (method, result["fps"], result["frames"] or max(1, round(result["duration"] * result["fps"])),
                result["duration"])
    except Exception:
        dest.unlink(missing_ok=True)
        raise
    finally:
        textfile.unlink(missing_ok=True)

def save_video_frame_png(media, target, last=False, metadata=None, embed_metadata=True):
    from PIL import Image, PngImagePlugin
    info = stitch_video_info(media)
    command = [ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error", "-nostdin"]
    if last and info["duration"] > .15:
        command.extend(["-sseof", f"-{min(1., max(.1, info['duration'] - .05)):.6f}"])
    command.extend(["-i", str(media), "-map", "0:v:0", "-an", "-vsync", "0"])
    if not last:
        command.extend(["-frames:v", "1"])
    run_checked(command + ["-update", "1", str(target)])
    if not Path(target).is_file():
        raise RuntimeError("Unable to extract video boundary frame")
    if embed_metadata and isinstance(metadata, dict):
        pnginfo = PngImagePlugin.PngInfo()
        if metadata.get("prompt") is not None:
            pnginfo.add_text("prompt", json.dumps(metadata["prompt"], ensure_ascii=False, default=str))
        if isinstance(metadata.get("extra_pnginfo"), dict):
            for key, value in metadata["extra_pnginfo"].items():
                pnginfo.add_text(str(key), json.dumps(value, ensure_ascii=False, default=str))
        with Image.open(target) as image:
            image.load()
            image.save(target, pnginfo=pnginfo, compress_level=4)
    return target
