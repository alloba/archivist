#!/usr/bin/env python3
"""
Find visually / audibly similar media files in a folder (standalone; not part of archivist's run).

Video and audio are fingerprinted and compared SEPARATELY, so the report has one
group list for video and one for audio. A video file that has an audio track
shows up in both lists if it matches something on both counts.

How it works
  * Video: grab N frames at fixed *relative* positions (5%, 15%, ... 95% of the
    duration), shrink each to 9x8 greyscale and compute a dHash (64 bits).
  * Audio: decode N short windows at the same relative positions to 8 kHz mono,
    compute energy in 8 log-spaced bands over 9 time slices and hash how each
    band's energy rises/falls over time (64 bits, so it ignores volume changes).
  * Two files match when their durations are close and enough of their
    fingerprints are within a Hamming-distance threshold.

Limits: positions are relative to duration, so a trimmed/extended copy, or one
with crops/letterboxing, won't match. Silent audio is skipped.

Requirements: Python 3.9+, ffmpeg + ffprobe on PATH, `pip install numpy`.

Usage (use a .json report if you want to feed it to remove_similar_media.py)
  python tools/find_similar_media.py FOLDER -o duplicates.txt
  python tools/find_similar_media.py FOLDER -o duplicates.json   # JSON if .json
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

try:
    import numpy as np
except ImportError:  # pragma: no cover
    sys.exit("numpy is required for audio fingerprinting: pip install numpy")

VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".mov", ".webm", ".wmv", ".flv", ".m4v",
              ".mpg", ".mpeg", ".ts", ".m2ts", ".3gp", ".ogv", ".gif"}
AUDIO_EXTS = {".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".wma",
              ".aiff", ".aif"}

POSITIONS = 10          # fingerprints per file per medium
AUDIO_WINDOW_SECS = 2.0
SAMPLE_RATE = 8000
CACHE_VERSION = 3


# --------------------------------------------------------------------------- ffmpeg helpers

def run(cmd: list[str], timeout: float = 120) -> bytes:
    try:
        return subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, check=False, timeout=timeout).stdout
    except subprocess.TimeoutExpired:
        return b""  # treated as unreadable / no data


def probe(path: Path) -> dict | None:
    out = run(["ffprobe", "-v", "error", "-show_entries",
               "format=duration,bit_rate:stream=codec_type,width,height"
               ":stream_disposition=attached_pic",
               "-of", "json", str(path)])
    try:
        info = json.loads(out)
        duration = float(info["format"]["duration"])
    except (ValueError, KeyError, TypeError):
        return None
    streams = info.get("streams", [])
    vstreams = [s for s in streams if s.get("codec_type") == "video"
                and not s.get("disposition", {}).get("attached_pic")]
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    try:
        bitrate = int(info["format"].get("bit_rate") or 0)
    except ValueError:
        bitrate = 0
    return {"duration": duration, "video": bool(vstreams), "audio": has_audio,
            "width": vstreams[0].get("width", 0) if vstreams else 0,
            "height": vstreams[0].get("height", 0) if vstreams else 0,
            "bitrate": bitrate}


def positions(duration: float) -> list[float]:
    return [duration * (i + 0.5) / POSITIONS for i in range(POSITIONS)]


# --------------------------------------------------------------------------- fingerprints

def video_hash(path: Path, t: float) -> int | None:
    raw = run(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-i", str(path), "-an", "-sn",
               "-frames:v", "1", "-vf", "scale=9:8:flags=area,format=gray",
               "-f", "rawvideo", "-"])
    if len(raw) != 72:
        return None
    px = np.frombuffer(raw, dtype=np.uint8).reshape(8, 9).astype(int)
    bits = (px[:, 1:] > px[:, :-1]).flatten()
    return int("".join("1" if b else "0" for b in bits), 2)


_edges = np.geomspace(300, 3400, 9)  # 8 log-spaced bands within the 4 kHz Nyquist


def audio_hash(path: Path, t: float) -> int | None:
    raw = run(["ffmpeg", "-v", "error", "-ss", f"{t:.3f}", "-t", f"{AUDIO_WINDOW_SECS}",
               "-i", str(path), "-vn", "-sn", "-ac", "1", "-ar", str(SAMPLE_RATE),
               "-f", "s16le", "-"])
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float64)
    chunk = len(samples) // 9
    if chunk < 256:
        return None
    energies = np.zeros((9, 8))
    freqs = np.fft.rfftfreq(chunk, 1 / SAMPLE_RATE)
    window = np.hanning(chunk)
    for i in range(9):
        power = np.abs(np.fft.rfft(samples[i * chunk:(i + 1) * chunk] * window)) ** 2
        for b in range(8):
            energies[i, b] = power[(freqs >= _edges[b]) & (freqs < _edges[b + 1])].sum()
    if energies.sum() < 1e3:      # (near-)silence carries no information
        return None
    bits = (energies[1:] > energies[:-1]).flatten()
    return int("".join("1" if b else "0" for b in bits), 2)


def fingerprint(path: Path) -> dict | None:
    meta = probe(path)
    if meta is None:
        return None
    ts = positions(meta["duration"])
    result = {"duration": meta["duration"], "video": None, "audio": None,
              "width": meta["width"], "height": meta["height"], "bitrate": meta["bitrate"],
              "has_video": meta["video"], "has_audio": meta["audio"],
              "size": path.stat().st_size}
    if meta["video"]:
        result["video"] = [video_hash(path, t) for t in ts]
    if meta["audio"]:
        result["audio"] = [audio_hash(path, t) for t in ts]
    # False for no audio track or silent audio (nothing to compare)
    result["audio_usable"] = any(h is not None for h in result["audio"] or [])
    return result


# --------------------------------------------------------------------------- matching

def similarity(a: list, b: list, max_bits: int) -> float | None:
    """Fraction of comparable positions whose hashes are within max_bits; None if too few."""
    pairs = [(x, y) for x, y in zip(a, b) if x is not None and y is not None]
    if len(pairs) < POSITIONS // 2:
        return None
    close = sum(1 for x, y in pairs if bin(x ^ y).count("1") <= max_bits)
    return close / len(pairs)


def group_matches(items: dict[str, dict], kind: str, max_bits: int, min_score: float,
                  dur_tol: float) -> list[list[dict]]:
    """items: path -> fingerprint record. Returns groups (size>=2) of {path, duration}."""
    cand = sorted((p for p, fp in items.items() if fp.get(kind)),
                  key=lambda p: items[p]["duration"])
    parent = {p: p for p in cand}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i, p in enumerate(cand):
        dp = items[p]["duration"]
        for q in cand[i + 1:]:
            dq = items[q]["duration"]
            if dq - dp > max(0.5, dp * dur_tol):
                break  # sorted by duration; nothing further can match p
            s = similarity(items[p][kind], items[q][kind], max_bits)
            if s is not None and s >= min_score:
                parent[find(q)] = find(p)

    groups: dict[str, list[dict]] = {}
    for p in cand:
        fp = items[p]
        groups.setdefault(find(p), []).append(
            {"path": p, "duration": round(fp["duration"], 2), "size": fp["size"],
             "width": fp["width"], "height": fp["height"], "bitrate": fp["bitrate"],
             "has_video": fp["has_video"], "audio_usable": fp["audio_usable"]})
    return sorted((g for g in groups.values() if len(g) > 1), key=lambda g: g[0]["path"])


# --------------------------------------------------------------------------- driver

def load_cache(path: Path | None) -> dict:
    if path and path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("version") == CACHE_VERSION:
                return data["files"]
            if data.get("version") == 2:  # v3 only added audio_usable, derivable from the hashes
                for entry in data["files"].values():
                    fp = entry["fp"]
                    fp["audio_usable"] = any(h is not None for h in fp.get("audio") or [])
                return data["files"]
        except (ValueError, KeyError, OSError):
            pass
    return {}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("folder", type=Path, help="folder to scan (recursively)")
    ap.add_argument("-o", "--output", type=Path, default=Path("similar_media.txt"),
                    help="report file; .json gives JSON, anything else gives text")
    ap.add_argument("--cache", type=Path, default=None,
                    help="fingerprint cache (default: <output>.cache.json); rescans skip unchanged files")
    ap.add_argument("--video-bits", type=int, default=10,
                    help="max differing bits (of 64) for two frames to count as the same (default 10)")
    ap.add_argument("--audio-bits", type=int, default=12,
                    help="same, for audio windows (default 12)")
    ap.add_argument("--min-score", type=float, default=0.8,
                    help="fraction of sampled positions that must match (default 0.8)")
    ap.add_argument("--duration-tolerance", type=float, default=0.02,
                    help="relative duration difference allowed (default 0.02 = 2%%)")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) // 2))
    ap.add_argument("--no-recurse", action="store_true")
    args = ap.parse_args()

    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} not found on PATH")
    if not args.folder.is_dir():
        sys.exit(f"not a folder: {args.folder}")

    root = args.folder.resolve()
    walker = root.glob("*") if args.no_recurse else root.rglob("*")
    files = sorted(p for p in walker
                   if p.is_file() and p.suffix.lower() in VIDEO_EXTS | AUDIO_EXTS)
    print(f"Found {len(files)} media files in {root}", file=sys.stderr)

    cache_path = args.cache or args.output.with_name(args.output.name + ".cache.json")
    cache = load_cache(cache_path)
    records: dict[str, dict] = {}
    todo = []
    for p in files:
        st = p.stat()
        key = str(p)
        c = cache.get(key)
        if c and c["size"] == st.st_size and c["mtime"] == st.st_mtime_ns:
            records[key] = c["fp"]
        else:
            todo.append(p)
    print(f"{len(files) - len(todo)} cached, {len(todo)} to fingerprint", file=sys.stderr)

    def work(p: Path):
        return p, fingerprint(p)

    failed = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for n, (p, fp) in enumerate(pool.map(work, todo), 1):
            print(f"[{n}/{len(todo)}] {p.name}", file=sys.stderr)
            if fp is None:
                failed.append(str(p))
                continue
            st = p.stat()
            cache[str(p)] = {"size": st.st_size, "mtime": st.st_mtime_ns, "fp": fp}
            records[str(p)] = fp

    # drop cache entries for files that no longer exist / aren't in this scan, then save
    cache_path.write_text(json.dumps({"version": CACHE_VERSION, "files": {
        k: v for k, v in cache.items() if k in records}}), encoding="utf-8")

    video_groups = group_matches(records, "video", args.video_bits, args.min_score,
                                 args.duration_tolerance)
    audio_groups = group_matches(records, "audio", args.audio_bits, args.min_score,
                                 args.duration_tolerance)

    def rel(path: str) -> str:
        return Path(path).relative_to(root).as_posix()

    def relgroups(groups):
        return [[{**m, "path": rel(m["path"])} for m in g] for g in groups]

    if args.output.suffix.lower() == ".json":
        # Paths are relative to the scanned folder so remove_similar_media.py can be
        # pointed at a different copy of the same tree (e.g. the NAS).
        args.output.write_text(json.dumps(
            {"root": str(root), "video": relgroups(video_groups),
             "audio": relgroups(audio_groups),
             "unreadable": [{"path": rel(f), "size": Path(f).stat().st_size}
                            for f in failed]}, indent=2), encoding="utf-8")
    else:
        lines = [f"Similar media in {root}", ""]
        for title, groups in (("VIDEO", video_groups), ("AUDIO", audio_groups)):
            lines.append(f"=== {title}: {len(groups)} group(s) ===")
            for i, g in enumerate(groups, 1):
                lines.append(f"\n{title.lower()} group {i}:")
                lines += [f"  {m['path']}  ({m['duration']}s)" for m in g]
            lines.append("")
        if failed:
            lines.append(f"=== UNREADABLE ({len(failed)}) ===")
            lines += [f"  {f}" for f in failed]
        args.output.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"Video groups: {len(video_groups)}, audio groups: {len(audio_groups)} "
          f"-> {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
