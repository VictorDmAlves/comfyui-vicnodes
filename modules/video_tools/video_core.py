"""Independent helpers for Vic Video Tools. No VideoHelperSuite code is used."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import uuid
import wave
from fractions import Fraction

import numpy as np
import torch

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mpg", ".mpeg", ".gif"}
CATEGORY = "Video Tools"


def frame_plan(seconds: float, fps: float, rule: str = "Wan (4n+1)", rounding: str = "Nearest"):
    seconds, fps = float(seconds), float(fps)
    if not math.isfinite(seconds) or seconds <= 0 or not math.isfinite(fps) or fps <= 0:
        raise ValueError("Video duration and FPS must be positive finite numbers.")
    target = seconds * fps
    if rule == "Wan (4n+1)":
        k = max(0, math.floor((target - 1) / 4 + 0.5))
        if rounding == "At least":
            k = max(0, math.ceil((target - 1 - 1e-8) / 4))
        elif rounding == "At most":
            k = max(0, math.floor((target - 1 + 1e-8) / 4))
        count = 4 * k + 1
    elif rule == "Any frame count":
        if rounding == "At least":
            count = math.ceil(target - 1e-8)
        elif rounding == "At most":
            count = math.floor(target + 1e-8)
        else:
            count = round(target)
        count = max(1, count)
    else:
        raise ValueError(f"Unknown temporal rule: {rule}")
    if count > 100000:
        raise ValueError("This plan requests too many frames (limit: 100,000).")
    return int(count), count / fps


def ffmpeg_path():
    candidate = os.getenv("VICVIDEO_FFMPEG") or shutil.which("ffmpeg")
    if not candidate:
        try:
            import imageio_ffmpeg
            candidate = imageio_ffmpeg.get_ffmpeg_exe()
        except (ImportError, RuntimeError):
            pass
    if not candidate:
        raise RuntimeError("FFmpeg not found. Install FFmpeg or set VICVIDEO_FFMPEG.")
    return candidate


def ffprobe_path():
    candidate = os.getenv("VICVIDEO_FFPROBE") or shutil.which("ffprobe")
    if not candidate:
        base = Path(ffmpeg_path())
        sibling = base.with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
        if sibling.is_file():
            candidate = str(sibling)
    if not candidate:
        raise RuntimeError("FFprobe not found. Add FFmpeg and FFprobe to PATH or set VICVIDEO_FFPROBE.")
    return candidate


def run_checked(args, **kwargs):
    proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    if proc.returncode != 0:
        message = proc.stderr.decode("utf-8", errors="replace")[-5000:]
        raise RuntimeError(f"FFmpeg failed (exit {proc.returncode}):\n{message}")
    return proc


def probe_video(path: str):
    result = run_checked([ffprobe_path(), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)])
    metadata = json.loads(result.stdout)
    streams = metadata.get("streams", [])
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    if not video:
        raise ValueError("The selected file does not contain a video stream.")
    fps_text = video.get("avg_frame_rate") or video.get("r_frame_rate") or "0/1"
    try:
        fps = float(Fraction(fps_text))
    except (TypeError, ValueError, ZeroDivisionError):
        fps = 0.0
    if not math.isfinite(fps) or fps <= 0:
        fps = 24.0
    duration = float(video.get("duration") or metadata.get("format", {}).get("duration") or 0)
    if not math.isfinite(duration) or duration < 0:
        duration = 0.0
    return {
        "fps": fps,
        "width": int(video["width"]),
        "height": int(video["height"]),
        "duration": duration,
        "frames": int(video.get("nb_frames") or 0),
        "has_audio": any(s.get("codec_type") == "audio" for s in streams),
    }


def even(value):
    return max(2, int(round(float(value) / 2) * 2))


def target_size(src_w, src_h, width, height, mode):
    src_w, src_h = int(src_w), int(src_h)
    width, height = int(width), int(height)
    if width < 1 and height < 1:
        return even(src_w), even(src_h)
    if width < 1:
        width = max(2, round(src_w * height / src_h))
    if height < 1:
        height = max(2, round(src_h * width / src_w))
    width, height = even(width), even(height)
    if mode == "Fit":
        multiplier = min(width / src_w, height / src_h)
        return even(src_w * multiplier), even(src_h * multiplier)
    return width, height


def video_filter(src_w, src_h, width, height, mode, fps):
    out_w, out_h = target_size(src_w, src_h, width, height, mode)
    filters = [f"fps={fps:.9g}"]
    if mode == "Crop":
        filters.append(f"scale={out_w}:{out_h}:force_original_aspect_ratio=increase")
        filters.append(f"crop={out_w}:{out_h}")
    else:
        filters.append(f"scale={out_w}:{out_h}:flags=lanczos")
    filters.append("format=rgb24")
    return ",".join(filters), out_w, out_h


def secure_file(base, name):
    # All media files are stored directly below the designated ComfyUI folder.
    if not isinstance(name, str) or not name or Path(name).name != name or "\\" in name:
        raise ValueError("Invalid video filename. Use a file inside the ComfyUI input folder.")
    path = (Path(base) / name).resolve()
    root = Path(base).resolve()
    if path.parent != root or path.suffix.lower() not in VIDEO_EXTENSIONS or not path.is_file():
        raise ValueError(f"Video file not found or invalid: {name}")
    return path


def safe_prefix(value):
    value = re.sub(r"[^A-Za-z0-9_-]+", "_", str(value or "VicVideo")).strip("_")[:64]
    return value or "VicVideo"


def output_path(directory, prefix, extension):
    """Create a numbered filename under a prefix-controlled output subdirectory.

    For example ``Videos/MyVideo`` -> ``output/Videos/MyVideo_00001.mp4``.
    Never allow output filenames to escape the requested output directory.
    """
    directory = Path(directory).resolve()
    raw = str(prefix or "VicVideo").replace("\\", "/").strip()
    if raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
        raise ValueError("filename_prefix must be relative to the ComfyUI output folder.")
    pieces = raw.split("/")
    if any(part in ("..", ".") for part in pieces):
        raise ValueError("filename_prefix cannot contain parent/current directory components.")
    clean = [safe_prefix(part) for part in pieces if part]
    if not clean:
        clean = ["VicVideo"]
    path_dir = directory.joinpath(*clean[:-1]).resolve()
    if not path_dir.is_relative_to(directory):
        raise ValueError("filename_prefix points outside the output folder.")
    path_dir.mkdir(parents=True, exist_ok=True)
    name = clean[-1]
    # A shared sequential suffix groups the video and its PNG snapshots together.
    for sequence in range(1, 100000):
        stem = f"{name}_{sequence:05d}"
        if not any(path_dir.glob(f"{stem}.*")):
            return path_dir / f"{stem}.{extension}", "" if path_dir == directory else path_dir.relative_to(directory).as_posix()
    raise RuntimeError("No free video filename could be found for this prefix.")


def save_first_frame_png(image, output_path, metadata=None, embed_metadata=True):
    """Save a thumbnail from the generated batch, embedding standard Comfy metadata."""
    from PIL import Image, PngImagePlugin

    if not torch.is_tensor(image) or image.ndim != 3 or image.shape[-1] < 3:
        raise ValueError("A video preview requires a [H, W, RGB] tensor.")
    raw = (image[:, :, :3].detach().cpu().clamp(0, 1).numpy() * 255 + .5).astype(np.uint8)
    png_metadata = None
    if embed_metadata and isinstance(metadata, dict):
        png_metadata = PngImagePlugin.PngInfo()
        prompt = metadata.get("prompt")
        if prompt is not None:
            png_metadata.add_text("prompt", json.dumps(prompt, ensure_ascii=False, default=str))
        extra_pnginfo = metadata.get("extra_pnginfo")
        if isinstance(extra_pnginfo, dict):
            for key, value in extra_pnginfo.items():
                png_metadata.add_text(str(key), json.dumps(value, ensure_ascii=False, default=str))
    Image.fromarray(raw, "RGB").save(str(output_path), pnginfo=png_metadata, compress_level=4)
    return output_path


def extract_frames(path, start_time, duration, requested_fps, width, height, mode,
                   skip, every, cap, max_memory_mb):
    info = probe_video(path)
    fps = float(requested_fps) if requested_fps > 0 else info["fps"]
    if not math.isfinite(fps) or fps <= 0 or fps > 240:
        raise ValueError("Invalid video FPS (must be between 0 and 240).")
    vf, w, h = video_filter(info["width"], info["height"], width, height, mode, fps)
    bytes_per_frame = w * h * 3
    if bytes_per_frame < 1:
        raise ValueError("Invalid video dimensions.")
    # IMAGE tensors are float32. Bound projected resident memory, not just raw RGB.
    max_frames_by_ram = max(1, (int(max_memory_mb) * 1024 * 1024) // (w * h * 4))
    count_limit = min(int(cap) if cap > 0 else 100000, max_frames_by_ram)
    args = [ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-nostdin"]
    if start_time > 0:
        args += ["-ss", f"{float(start_time):.6f}"]
    args += ["-i", str(path)]
    if duration > 0:
        args += ["-t", f"{float(duration):.6f}"]
    args += ["-map", "0:v:0", "-vf", vf, "-an", "-pix_fmt", "rgb24", "-f", "rawvideo", "-vsync", "0", "pipe:1"]
    frames = []
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=bytes_per_frame * 2)
    consumed = 0
    natural_end = False
    try:
        while len(frames) < count_limit:
            raw = proc.stdout.read(bytes_per_frame)
            if not raw:
                natural_end = True
                break
            if len(raw) != bytes_per_frame:
                raise RuntimeError("Truncated frame received from FFmpeg decoder.")
            if consumed >= skip and (consumed - skip) % every == 0:
                # Copy: stdout's backing buffer must not be retained by NumPy.
                frames.append(np.frombuffer(raw, dtype=np.uint8).reshape((h, w, 3)).copy())
            consumed += 1
        if not frames:
            raise ValueError("No video frames were loaded. Check the selected time range.")
    finally:
        if not natural_end and proc.poll() is None:
            proc.terminate()
        if proc.stdout:
            proc.stdout.close()
            proc.stdout = None
        try:
            _, errors = proc.communicate(timeout=6)
        except subprocess.TimeoutExpired:
            proc.kill()
            _, errors = proc.communicate()
    if natural_end and proc.returncode not in (0, None):
        raise RuntimeError(errors.decode("utf8", errors="replace")[-2500:])
    array = np.stack(frames)
    images = torch.from_numpy(array).to(torch.float32).div_(255.0)
    del frames, array
    loaded_fps = fps / every
    # Skipping at the beginning changes the audio start, while selecting every Nth
    # keeps overall duration when played back at the reduced FPS.
    effective_start = float(start_time) + skip / fps
    loaded_duration = images.shape[0] / loaded_fps
    memory_limited = cap == 0 and len(images) >= max_frames_by_ram
    return images, info, loaded_fps, loaded_duration, effective_start, memory_limited


def decode_audio(path, start_time, duration, has_audio):
    sr = 44100
    if not has_audio:
        return {"waveform": torch.empty((1, 2, 0), dtype=torch.float32), "sample_rate": sr}
    args = [ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-nostdin"]
    if start_time > 0:
        args += ["-ss", f"{float(start_time):.6f}"]
    args += ["-i", str(path), "-t", f"{max(0.001, float(duration)):.6f}", "-map", "0:a:0", "-vn", "-ac", "2", "-ar", str(sr), "-f", "f32le", "pipe:1"]
    output = run_checked(args).stdout
    samples = np.frombuffer(output, dtype="<f4").copy()
    samples = samples[: len(samples) // 2 * 2]
    wave_data = torch.from_numpy(samples.reshape(-1, 2).T.copy()).unsqueeze(0)
    return {"waveform": wave_data, "sample_rate": sr}


def write_audio_wav(audio, output_path):
    if not isinstance(audio, dict) or "waveform" not in audio or "sample_rate" not in audio:
        raise ValueError("Audio input must be a ComfyUI AUDIO object.")
    tensor = audio["waveform"]
    if tensor.ndim != 3 or tensor.shape[0] != 1 or tensor.shape[1] not in (1, 2):
        raise ValueError("Audio waveform must be shaped [1, 1 or 2, samples].")
    if tensor.shape[2] == 0:
        return False
    sr = int(audio["sample_rate"])
    if sr < 8000 or sr > 192000:
        raise ValueError("Invalid audio sample rate.")
    raw = (tensor.detach().cpu().clamp(-1, 1).squeeze(0).T.contiguous().numpy() * 32767).astype("<i2")
    with wave.open(str(output_path), "wb") as wf:
        wf.setnchannels(tensor.shape[1])
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(raw.tobytes())
    return True


def encoder_args(encoder, container, crf, pix_fmt, preset):
    configs = {
        "H.264 CPU": ("libx264", ["-crf", str(crf), "-preset", preset]),
        "H.264 NVENC": ("h264_nvenc", ["-cq", str(crf), "-rc", "vbr", "-preset", "p4"]),
        "H.265 CPU": ("libx265", ["-crf", str(crf), "-preset", preset]),
        "H.265 NVENC": ("hevc_nvenc", ["-cq", str(crf), "-rc", "vbr", "-preset", "p4"]),
        "AV1 NVENC": ("av1_nvenc", ["-cq", str(crf), "-rc", "vbr", "-preset", "p4"]),
        "VP9 CPU": ("libvpx-vp9", ["-crf", str(crf), "-b:v", "0", "-deadline", "good"]),
        "GIF": ("gif", []),
    }
    if encoder not in configs:
        raise ValueError(f"Unknown video encoder: {encoder}")
    if container == "gif" and encoder != "GIF":
        raise ValueError("GIF format requires the GIF encoder.")
    if container != "gif" and encoder == "GIF":
        raise ValueError("The GIF encoder requires gif format.")
    if container == "webm" and encoder != "VP9 CPU":
        raise ValueError("WebM requires the VP9 CPU encoder in this prototype.")
    if container == "mp4" and encoder == "VP9 CPU":
        raise ValueError("VP9 CPU requires WebM or MKV format.")
    codec, opts = configs[encoder]
    if codec == "gif":
        return ["-c:v", codec]
    return ["-c:v", codec] + opts + ["-pix_fmt", pix_fmt]


def frame_indices(count, pingpong, loops):
    forward = list(range(count))
    cycle = forward + forward[-2:0:-1] if pingpong and count > 2 else forward
    for _ in range(int(loops)):
        yield from cycle


def encode_images(images, output_path, fps, encoder, container, crf, pix_fmt, preset,
                  pingpong=False, loops=1, save_metadata=False, metadata=None, audio=None):
    if not torch.is_tensor(images) or images.ndim != 4 or images.shape[-1] not in (3, 4):
        raise ValueError("Video Combine requires an IMAGE tensor [frames, height, width, RGB/RGBA].")
    count, h, w, _ = images.shape
    if count < 1:
        raise ValueError("Cannot encode an empty image batch.")
    if w % 2 or h % 2:
        # Even dimensions are necessary for yuv420p; all codecs get consistent size.
        raise ValueError(f"Image dimensions must be even for export (got {w}x{h}).")
    if fps <= 0 or fps > 240 or not math.isfinite(fps):
        raise ValueError("Invalid output FPS.")
    per_loop = int(count) + (int(count) - 2 if pingpong and count > 2 else 0)
    total = per_loop * int(loops)
    if total > 500000:
        raise ValueError("Export exceeds the 500,000-frame safety limit.")
    indices = frame_indices(int(count), pingpong, loops)
    duration = total / fps
    output_path = Path(output_path)
    work_dir = output_path.parent
    temp_video = work_dir / f".vicvideo_{uuid.uuid4().hex}.{container}"
    temp_audio = work_dir / f".vicvideo_{uuid.uuid4().hex}.wav"
    cmd = [ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-s:v", f"{w}x{h}",
           "-r", f"{float(fps):.9g}", "-i", "pipe:0", "-an"]
    cmd += encoder_args(encoder, container, crf, pix_fmt, preset)
    cmd += ["-frames:v", str(total), str(temp_video)]
    proc = None
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for index in indices:
            frame = images[index, :, :, :3].detach().cpu().clamp(0, 1)
            data = (frame.numpy() * 255.0 + 0.5).astype(np.uint8)
            try:
                proc.stdin.write(data.tobytes())
            except BrokenPipeError:
                break
        proc.stdin.close()
        # communicate() tries to flush a closed stdin unless it is set to None.
        proc.stdin = None
        _, stderr = proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"FFmpeg encoding failed:\n{stderr.decode('utf8', 'replace')[-3000:]}")
        if audio is not None and container != "gif" and write_audio_wav(audio, temp_audio):
            a_codec = "libopus" if container == "webm" else "aac"
            run_checked([ffmpeg_path(), "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
                         "-i", str(temp_video), "-i", str(temp_audio), "-map", "0:v:0", "-map", "1:a:0",
                         "-c:v", "copy", "-c:a", a_codec, "-af", "apad", "-t", f"{duration:.6f}", str(output_path)])
        else:
            os.replace(temp_video, output_path)
        return total, duration
    finally:
        if proc is not None and proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
        for path in (temp_video, temp_audio):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
