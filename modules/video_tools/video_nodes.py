"""VicNodes Video Tools: duration, loading, encoding and stitching."""

from __future__ import annotations

from pathlib import Path
import math

import torch
import folder_paths

from .video_core import (
    VIDEO_EXTENSIONS, decode_audio, encode_images, extract_frames, frame_plan,
    secure_file, output_path, save_first_frame_png,
)
from .stitch_core import resolve_video_source, stitch_videos, save_video_frame_png


class VicVideoDuration:
    """Converts human-friendly seconds to valid model length and output FPS."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "seconds": ("FLOAT", {"default": 5.0, "min": 0.1, "max": 600.0, "step": 0.1, "round": 0.01, "tooltip": "Desired video length in seconds. The resulting frame count may be rounded to fit the model temporal rule."}),
            "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 240.0, "step": 1.0, "round": 0.001, "tooltip": "Frames per second used to calculate length and suggested for playback. It does not interpolate new images."}),
            "temporal_rule": (["Wan (4n+1)", "Any frame count"], {"default": "Wan (4n+1)", "tooltip": "Wan (4n+1) uses frame counts 1, 5, 9, etc., required by many Wan video latents. Any frame count disables that restriction."}),
            "rounding": (["Nearest", "At least", "At most"], {"default": "Nearest", "tooltip": "Nearest: closest valid length. At least: never shorter than requested. At most: never longer than requested."}),
        }}

    RETURN_TYPES = ("INT", "FLOAT", "FLOAT", "STRING")
    RETURN_NAMES = ("length", "frame_rate", "actual_seconds", "summary")
    FUNCTION = "run"
    CATEGORY = "VicNodes/Video Tools"

    def run(self, seconds, fps, temporal_rule, rounding):
        frames, actual = frame_plan(seconds, fps, temporal_rule, rounding)
        summary = f"{frames} frames | {fps:g} FPS | {actual:.3f} seconds"
        return {"ui": {"vic_duration": [{"frames": frames, "fps": fps, "seconds": actual}]},
                "result": (frames, fps, actual, summary)}


class VicVideoLoad:
    """Loads video frames with FFmpeg, exposing matching AUDIO and FPS."""

    @classmethod
    def INPUT_TYPES(cls):
        folder = Path(folder_paths.get_input_directory())
        files = sorted(p.name for p in folder.iterdir()
                       if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS) if folder.exists() else []
        return {"required": {
            "video": (files or ["Upload a video first"], {"tooltip": "Choose a clip in ComfyUI/input or use the Upload Video button inside the player."}),
            "start_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.1, "tooltip": "Start decoding at this time (seconds) in the source video."}),
            "duration": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100000.0, "step": 0.1, "tooltip": "How many seconds to load after start_time. 0 loads the remainder of the file."}),
            "force_fps": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 240.0, "step": 1.0, "tooltip": "0 preserves the original FPS. A positive FPS duplicates or drops decoded frames as needed."}),
            "force_width": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 2, "tooltip": "Output width in pixels. 0 uses original width; one nonzero dimension preserves aspect ratio."}),
            "force_height": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 2, "tooltip": "Output height in pixels. 0 uses original height; one nonzero dimension preserves aspect ratio."}),
            "resize_mode": (["Fit", "Stretch", "Crop"], {"tooltip": "Fit: preserve aspect ratio inside a box. Stretch: fill exact dimensions. Crop: fill then center-crop."}),
            "skip_first_frames": ("INT", {"default": 0, "min": 0, "max": 1000000, "tooltip": "Skip this many frames AFTER optional FPS resampling."}),
            "select_every_nth": ("INT", {"default": 1, "min": 1, "max": 10000, "tooltip": "Keep every Nth loaded frame. For example, 2 keeps alternate frames and halves the reported FPS."}),
            "frame_load_cap": ("INT", {"default": 0, "min": 0, "max": 100000, "tooltip": "Maximum frames to decode. 0 means no explicit frame cap; max_memory_mb still applies."}),
            "max_memory_mb": ("INT", {"default": 2048, "min": 128, "max": 32768, "step": 128, "tooltip": "Conservative RAM budget for returned IMAGE frames in MB. Does not include every decoder or model allocation."}),
        }}

    RETURN_TYPES = ("IMAGE", "MASK", "AUDIO", "FLOAT", "INT", "FLOAT", "STRING")
    RETURN_NAMES = ("images", "mask", "audio", "frame_rate", "frame_count", "duration", "video_info")
    FUNCTION = "load"
    CATEGORY = "VicNodes/Video Tools"

    @classmethod
    def IS_CHANGED(cls, video, **kwargs):
        try:
            path = secure_file(folder_paths.get_input_directory(), video)
            stat = path.stat()
            return (stat.st_mtime_ns, stat.st_size)
        except (ValueError, OSError):
            return float("nan")

    @classmethod
    def VALIDATE_INPUTS(cls, video, **kwargs):
        try:
            secure_file(folder_paths.get_input_directory(), video)
            return True
        except ValueError as exc:
            return str(exc)

    def load(self, video, start_time, duration, force_fps, force_width, force_height,
             resize_mode, skip_first_frames, select_every_nth, frame_load_cap, max_memory_mb):
        source = secure_file(folder_paths.get_input_directory(), video)
        images, info, fps, seconds, audio_start, was_memory_limited = extract_frames(
            source, start_time, duration, force_fps, force_width, force_height, resize_mode,
            skip_first_frames, select_every_nth, frame_load_cap, max_memory_mb)
        masks = torch.zeros((images.shape[0], images.shape[1], images.shape[2]), dtype=torch.float32)
        audio = decode_audio(source, audio_start, seconds, info["has_audio"])
        message = (
            f"{source.name}: {info['width']}x{info['height']} at {info['fps']:.3f} FPS "
            f"(source {info['duration']:.3f}s) | loaded {images.shape[0]} frames, "
            f"{images.shape[2]}x{images.shape[1]}, {fps:.3f} FPS, {seconds:.3f}s"
        )
        if was_memory_limited:
            message += " | STOPPED at max_memory_mb limit"
        print(f"[Vic Video Tools] {message}")
        return {"ui": {"vic_video_input": [{"filename": video, "fps": fps,
                                             "frames": int(images.shape[0]), "seconds": seconds,
                                             "memory_limited": was_memory_limited}]},
                "result": (images, masks, audio, float(fps), int(images.shape[0]), float(seconds), message)}


class VicVideoCombine:
    """Exports an IMAGE batch into a video file with optional ComfyUI AUDIO."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE", {"tooltip": "IMAGE batch to encode. Frame order determines video order."}),
            "fps_mode": (["Auto", "Manual"], {"default": "Auto", "tooltip": "Auto: use connected frame_rate when available, otherwise manual_fps. Manual: always use manual_fps."}),
            "manual_fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 240.0, "step": 1.0, "tooltip": "Playback/export FPS for Manual mode or Auto without a frame_rate connection. Changing FPS changes playback speed, not frame count."}),
            "format": (["mp4", "mkv", "webm", "gif"], {"default": "mp4", "tooltip": "Output container or GIF format. MP4 + H.264 is usually easiest to preview and share."}),
            "encoder": (["H.264 CPU", "H.264 NVENC", "H.265 CPU", "H.265 NVENC",
                         "AV1 NVENC", "VP9 CPU", "GIF"], {"default": "H.264 CPU", "tooltip": "Video codec and CPU/GPU backend. NVIDIA NVENC modes require supported hardware and FFmpeg encoder availability."}),
            "quality_crf": ("INT", {"default": 18, "min": 0, "max": 51, "tooltip": "Compression quality control: lower numbers generally mean better quality/larger files. NVENC uses CQ instead of CRF."}),
            "pixel_format": (["yuv420p", "yuv444p", "yuv420p10le"], {"default": "yuv420p", "tooltip": "Video pixel format. yuv420p is most compatible; 10-bit and 4:4:4 need encoder and player support."}),
            "cpu_preset": (["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower"], {"default": "medium", "tooltip": "CPU encode speed/efficiency tradeoff: slower may produce smaller files. Mostly ignored for NVENC."}),
            "pingpong": ("BOOLEAN", {"default": False, "tooltip": "Append frames backward after the forward sequence, excluding repeated endpoints."}),
            "loops": ("INT", {"default": 1, "min": 1, "max": 1000, "tooltip": "Repeat the full sequence this many times in the exported video."}),
            "filename_prefix": ("STRING", {"default": "VicVideo", "tooltip": "Output name prefix. Subfolders work, e.g. Videos/VicVideo; filenames get increasing numeric suffixes."}),
            "save_metadata": ("BOOLEAN", {"default": True, "tooltip": "Embed available ComfyUI prompt and workflow metadata in saved first/last PNG frames. No separate JSON file is created."}),
            "save_output": ("BOOLEAN", {"default": True, "tooltip": "True saves inside ComfyUI/output; false uses ComfyUI/temp (which may be cleared)."}),
            "save_first_frame": ("BOOLEAN", {"default": True, "tooltip": "Also save the first source frame as a PNG beside the video."}),
            "save_last_frame": ("BOOLEAN", {"default": True, "tooltip": "Also save the final timeline frame as _last.png; last_frame IMAGE is available independently."}),
        }, "optional": {
            "frame_rate": ("FLOAT", {"forceInput": True, "tooltip": "Optional output FPS supplied by Video Duration or Video Load. Used when fps_mode = Auto."}),
            "audio": ("AUDIO", {"tooltip": "Optional ComfyUI AUDIO stream to mux with the exported video."}),
        }, "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"}}

    RETURN_TYPES = ("STRING", "FLOAT", "INT", "FLOAT", "IMAGE")
    RETURN_NAMES = ("file_path", "frame_rate", "frame_count", "duration", "last_frame")
    FUNCTION = "combine"
    CATEGORY = "VicNodes/Video Tools"
    OUTPUT_NODE = True

    def combine(self, images, fps_mode, manual_fps, format, encoder, quality_crf,
                pixel_format, cpu_preset, pingpong, loops, filename_prefix,
                save_metadata, save_output, save_first_frame=True, save_last_frame=True, frame_rate=None, audio=None,
                prompt=None, extra_pnginfo=None):
        fps = float(frame_rate) if fps_mode == "Auto" and frame_rate is not None else float(manual_fps)
        if not math.isfinite(fps) or fps <= 0:
            raise ValueError("Invalid Video Combine FPS.")
        folder = folder_paths.get_output_directory() if save_output else folder_paths.get_temp_directory()
        path, subfolder = output_path(folder, filename_prefix, format)
        total, seconds = encode_images(
            images, path, fps, encoder, format, quality_crf, pixel_format, cpu_preset,
            pingpong=pingpong, loops=loops, save_metadata=save_metadata,
            metadata={"prompt": prompt, "extra_pnginfo": extra_pnginfo}, audio=audio)
        png_name = None
        if save_first_frame:
            png_path = path.with_suffix(".png")
            save_first_frame_png(images[0], png_path,
                                 {"prompt": prompt, "extra_pnginfo": extra_pnginfo},
                                 embed_metadata=save_metadata)
            png_name = png_path.name
        # The final timeline frame reflects pingpong playback when enabled.
        last_index = 1 if pingpong and images.shape[0] > 2 else images.shape[0] - 1
        last_frame = images[last_index:last_index+1, :, :, :3].contiguous()
        if save_last_frame:
            save_first_frame_png(last_frame[0], path.with_name(path.stem + "_last.png"),
                                 {"prompt": prompt, "extra_pnginfo": extra_pnginfo},
                                 embed_metadata=save_metadata)
        print(f"[Vic Video Tools] Exported {total} frames at {fps:.3f} FPS to {path}")
        return {"ui": {"vic_video": [{"filename": path.name, "subfolder": subfolder,
                                        "type": "output" if save_output else "temp",
                                        "thumbnail": png_name,
                                        "fps": fps, "frames": total, "seconds": seconds}]},
                "result": (str(path), fps, total, seconds, last_frame)}



class AnyVideoSlotDict(dict):
    """Allow optional numbered STRING input sockets to be created by frontend."""
    def __contains__(self, key):
        if super().__contains__(key):
            return True
        if isinstance(key, str) and key.startswith("video_"):
            try:
                return 3 <= int(key[6:]) <= 16
            except ValueError:
                pass
        return False


class VicVideoStitch:
    """Stitch encoded clips by file path, preserving stream copies if possible."""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "manual_files": ("STRING", {"default": "", "multiline": True,
                       "tooltip": "One clip path per line. Example: input:clip.mp4 or output:Videos/clip.mp4"}),
            "stitch_mode": (["Auto", "Copy", "Re-encode"], {"default": "Auto", "tooltip": "Auto: stream-copy compatible clips, otherwise re-encode. Copy: require direct copy. Re-encode: always encode a new video."}),
            "audio_mode": (["Auto", "Mute"], {"default": "Auto", "tooltip": "Auto: keep compatible audio or fill missing segments with silence on re-encode. Mute: video only."}),
            "format": (["mp4", "mkv", "webm"], {"default": "mp4", "tooltip": "Output format MP4/MKV/WebM. Codec and container must be compatible when re-encoding."}),
            "encoder": (["H.264 CPU", "H.264 NVENC", "H.265 CPU", "H.265 NVENC",
                         "AV1 NVENC", "VP9 CPU"], {"default": "H.264 CPU", "tooltip": "Codec used when re-encoding. NVENC needs supported NVIDIA GPU/FFmpeg; Copy ignores this setting."}),
            "quality_crf": ("INT", {"default": 18, "min": 0, "max": 51, "tooltip": "Compression quality for re-encoding (lower is better quality and larger file). Ignored in Copy mode."}),
            "pixel_format": (["yuv420p", "yuv444p", "yuv420p10le"], {"default": "yuv420p", "tooltip": "Output pixel format for re-encoding. yuv420p is the most compatible."}),
            "cpu_preset": (["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower"],
                           {"default": "medium", "tooltip": "CPU encoding speed versus compression efficiency. Ignored for Copy and most NVENC modes."}),
            "target_fps": ("FLOAT", {"default": 0, "min": 0, "max": 240, "step": 1,
                           "tooltip": "0: use first clip FPS; different target FPS forces re-encode"}),
            "filename_prefix": ("STRING", {"default": "Videos/Stitched", "tooltip": "File prefix and optional subfolder, e.g. Videos/Stitched. A numeric suffix is added automatically."}),
            "save_first_frame": ("BOOLEAN", {"default": True, "tooltip": "Save the beginning of the joined video as PNG for preview and reuse."}),
            "save_last_frame": ("BOOLEAN", {"default": True, "tooltip": "Save the ending of the joined video as _last.png for Wan continuation."}),
            "save_metadata": ("BOOLEAN", {"default": True, "tooltip": "Embed available ComfyUI prompt and workflow metadata in saved first/last PNG images. Does not create a separate JSON file."}),
            "save_output": ("BOOLEAN", {"default": True, "tooltip": "True stores video in ComfyUI/output; false stores it in temporary files."}),
            # Append new widgets: old saved ComfyUI widget values stay aligned.
            "seam_mode": (["Cut", "Remove Duplicate", "Crossfade"], {
                "default": "Cut", "tooltip": "Cut: direct join (fastest). Remove Duplicate: compare the last/first frames and drop a matching first frame. Crossfade: blend clips smoothly. Both advanced modes may re-encode."}),
            "crossfade_seconds": ("FLOAT", {"default": 0.35, "min": 0.04, "max": 3.0,
                "step": 0.05, "round": 0.001,
                "tooltip": "Transition duration in seconds between EACH pair of adjacent clips. Only used for Crossfade. Overlap shortens the final runtime and requires re-encoding."}),
            "duplicate_threshold": ("FLOAT", {"default": 0.02, "min": 0.0, "max": 0.15,
                "step": 0.005, "round": 0.001,
                "tooltip": "Sensitivity for Remove Duplicate (normalized grayscale mean absolute difference). 0 is exact only; 0.02 is conservative. Higher values may remove frames with genuine motion."}),
        }, "optional": AnyVideoSlotDict({
            "video_1": ("STRING", {"forceInput": True, "tooltip": "First input video path (STRING), typically from Video Combine.file_path."}),
            "video_2": ("STRING", {"forceInput": True, "tooltip": "Second input video path (STRING); further video inputs can be added below."}),
        }), "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"}}

    RETURN_TYPES = ("STRING", "FLOAT", "INT", "FLOAT", "STRING")
    RETURN_NAMES = ("file_path", "frame_rate", "frame_count", "duration", "method")
    FUNCTION = "stitch"
    CATEGORY = "VicNodes/Video Tools"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, manual_files="", **kwargs):
        roots = {"input": folder_paths.get_input_directory(),
                 "output": folder_paths.get_output_directory(),
                 "temp": folder_paths.get_temp_directory()}
        names = [v.strip() for v in str(manual_files).splitlines() if v.strip() and not v.strip().startswith("#")]
        names += [v for k, v in sorted(kwargs.items()) if k.startswith("video_") and isinstance(v, str) and v.strip()]
        status = []
        for name in names:
            try:
                path = resolve_video_source(name, roots)
                stat = path.stat()
                status.append((str(path), stat.st_size, stat.st_mtime_ns))
            except (ValueError, OSError):
                status.append((name, None, None))
        return repr(status)

    def stitch(self, manual_files, stitch_mode, audio_mode, format, encoder, quality_crf,
               pixel_format, cpu_preset, target_fps, filename_prefix, save_first_frame,
               save_last_frame, save_metadata, save_output,
               seam_mode="Cut", crossfade_seconds=0.35, duplicate_threshold=0.02,
               prompt=None, extra_pnginfo=None,
               video_1=None, video_2=None, **kwargs):
        roots = {"input": folder_paths.get_input_directory(),
                 "output": folder_paths.get_output_directory(),
                 "temp": folder_paths.get_temp_directory()}
        connected = {"video_1": video_1, "video_2": video_2, **kwargs}
        paths = []
        for index in range(1, 17):
            value = connected.get(f"video_{index}")
            if isinstance(value, str) and value.strip():
                paths.append(resolve_video_source(value, roots))
        for value in str(manual_files or "").splitlines():
            if value.strip() and not value.strip().startswith("#"):
                paths.append(resolve_video_source(value.strip(), roots))
        if not 2 <= len(paths) <= 16:
            raise ValueError("Video Stitch requires 2-16 clips. Connect Video Combine.file_path or upload clips.")
        directory = roots["output"] if save_output else roots["temp"]
        destination, subfolder = output_path(directory, filename_prefix, format)
        method, fps, frames, seconds = stitch_videos(paths, destination, stitch_mode,
            audio_mode, encoder, format, quality_crf, pixel_format, cpu_preset, float(target_fps),
            seam_mode, float(crossfade_seconds), float(duplicate_threshold))
        metadata = {"prompt": prompt, "extra_pnginfo": extra_pnginfo}
        thumbnail = None
        if save_first_frame:
            first = destination.with_suffix(".png")
            save_video_frame_png(destination, first, last=False, metadata=metadata, embed_metadata=save_metadata)
            thumbnail = first.name
        if save_last_frame:
            save_video_frame_png(destination, destination.with_name(destination.stem + "_last.png"),
                                 last=True, metadata=metadata, embed_metadata=save_metadata)
        print(f"[Vic Video Tools] Stitched {len(paths)} clips by {method} ({seam_mode}): {destination}")
        return {"ui": {"vic_video": [{"filename": destination.name, "subfolder": subfolder,
                         "type": "output" if save_output else "temp", "thumbnail": thumbnail,
                         "fps": fps, "frames": frames, "seconds": seconds, "method": method}]},
                "result": (str(destination), fps, frames, seconds, method)}


NODE_CLASS_MAPPINGS = {
    "VicVideoDuration": VicVideoDuration,
    "VicVideoLoad": VicVideoLoad,
    "VicVideoCombine": VicVideoCombine,
    "VicVideoStitch": VicVideoStitch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VicVideoDuration": "Video Duration",
    "VicVideoLoad": "Video Load",
    "VicVideoCombine": "Video Combine",
    "VicVideoStitch": "Video Stitch",
}
