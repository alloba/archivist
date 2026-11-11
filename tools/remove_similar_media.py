#!/usr/bin/env python3
"""
Remove duplicates and unreadable files listed in a find_similar_media.py JSON report.

Standalone; not part of archivist's run. DRY RUN by default: nothing is touched
unless you pass --apply.

The report stores paths relative to the folder that was scanned, so you can scan
a local copy and then apply the removals to another copy of the same tree:

  python tools/find_similar_media.py D:\\local\\videos -o report.json
  python tools/remove_similar_media.py report.json --root \\\\nas\\share\\videos            # preview
  python tools/remove_similar_media.py report.json --root \\\\nas\\share\\videos --apply    # do it

What counts as a duplicate
  By default a video file is only removed if it matches the keeper BOTH visually and
  by audio (same video group and same audio group). Pairs that match visually but not
  by audio are left alone and listed under "Skipped". If neither file has usable audio
  (no audio track, or silence) the visual match alone is accepted and labelled as such.
  Pass --video-only to remove on a visual match alone.

Which file is kept in each group
  * Video groups: highest resolution, then bitrate, then file size.
  * Audio groups: highest bitrate, then file size.
  Ties go to the shortest, then alphabetically first, path.

Safety rules
  * Audio-only files are removed on an audio match (there is no picture to compare).
  * Audio matches only ever remove audio-only files. A video file is never deleted
    because its soundtrack matched something.
  * A file that is the keeper of any group is never removed.
  * A file is only touched if it exists under --root and its size equals the size
    recorded in the report (i.e. it's the same file that was scanned). Likewise a
    group's keeper must exist with the recorded size, or the group is skipped.
  * "Unreadable" files are re-probed with ffprobe first and skipped if they now read fine.
  * --quarantine DIR moves files there (keeping their subpath) instead of deleting them.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from find_similar_media import probe  # noqa: E402


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024
    return str(n)


def quality(m: dict, kind: str) -> tuple:
    bitrate = m["bitrate"] or 0
    if kind == "video":
        return (m["width"] * m["height"], bitrate, m["size"])
    return (bitrate, m["size"])


def pick_keeper(group: list[dict], kind: str) -> dict:
    # max quality; ties -> shortest path, then alphabetical
    return max(group, key=lambda m: (quality(m, kind), -len(m["path"]), [-ord(c) for c in m["path"]]))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("report", type=Path, help="JSON report from find_similar_media.py")
    ap.add_argument("--root", type=Path, default=None,
                    help="folder holding the files to act on (default: the folder the report was scanned from)")
    ap.add_argument("--apply", action="store_true", help="actually delete/move (default is a dry run)")
    ap.add_argument("--quarantine", type=Path, default=None,
                    help="move removed files here (subpaths preserved) instead of deleting")
    ap.add_argument("--video-only", action="store_true",
                    help="remove video duplicates on a visual match alone, without requiring the audio to match")
    ap.add_argument("--keep-unreadable", action="store_true", help="leave unreadable files alone")
    args = ap.parse_args()

    try:
        report = json.loads(args.report.read_text(encoding="utf-8"))
        missing = {"root", "video", "audio", "unreadable"} - set(report)
    except (ValueError, TypeError):
        report, missing = None, {"root"}
    if report is None or missing:
        sys.exit(f"{args.report} is not a find_similar_media.py JSON report"
                 " (is it the .cache.json file or a text report?). Re-run the finder with -o something.json")
    root =(args.root or Path(report["root"])).resolve()
    if not root.is_dir():
        sys.exit(f"root is not a folder: {root}")

    def resolve(rel: str) -> Path | None:
        p = (root / rel).resolve()
        return p if root in p.parents else None  # refuse anything escaping root

    def present(m: dict) -> str | None:
        """None if the file on disk is the one that was scanned, else the reason it isn't."""
        p = resolve(m["path"])
        if p is None:
            return "path escapes root"
        if not p.is_file():
            return "missing"
        if p.stat().st_size != m["size"]:
            return f"size differs ({p.stat().st_size} vs {m['size']} scanned)"
        return None

    print("Planning (no changes are made until --apply)...", file=sys.stderr)
    plan: list[tuple[str, dict]] = []   # (reason, member)
    skipped: list[tuple[str, str]] = []   # (category, detail line)
    keepers: set[str] = set()
    pending: list[tuple[str, dict, dict]] = []  # (kind-label, keeper, victim)

    audio_group_of = {m["path"]: i for i, g in enumerate(report["audio"]) for m in g}

    def audio_verdict(keeper: dict, m: dict) -> str | None:
        """Label for how a visual match is confirmed; None means the audio disagrees."""
        if audio_group_of.get(keeper["path"], -1) == audio_group_of.get(m["path"], -2):
            return "video+audio"
        if not keeper["audio_usable"] and not m["audio_usable"]:
            return "video only, no audio to compare"
        return None

    for kind in ("video", "audio"):
        for i, group in enumerate(report[kind], 1):
            # audio matches may only remove audio-only files; video files are never victims there
            candidates = group if kind == "video" else [m for m in group if not m["has_video"]]
            if len(candidates) < 2:
                continue
            keeper = pick_keeper(candidates, kind)
            why = present(keeper)
            if why:
                skipped.append(("group skipped: keeper missing or changed", f"{kind} group {i}: keeper {keeper['path']} {why}; group skipped"))
                continue
            keepers.add(keeper["path"])
            for m in candidates:
                if m is keeper:
                    continue
                label = kind
                if kind == "video" and not args.video_only:
                    label = audio_verdict(keeper, m)
                    if label is None:
                        skipped.append(("looks the same but audio differs", f"{m['path']}: looks like {keeper['path']} but the audio differs; kept"))
                        continue
                pending.append((f"duplicate of {keeper['path']} ({label})", keeper, m))

    seen: set[str] = set()
    for n, (reason, keeper, m) in enumerate(pending, 1):
        if n % 50 == 0 or n == len(pending):
            print(f"[{n}/{len(pending)}] checking duplicates on disk", file=sys.stderr)
        if m["path"] in keepers:
            skipped.append(("is the keeper of another group", f"{m['path']}: is the keeper of another group; kept"))
        elif m["path"] in seen:
            continue
        elif (why := present(m)):
            skipped.append(("file missing or size changed", f"{m['path']}: {why}; kept"))
        else:
            seen.add(m["path"])
            plan.append((reason, m))

    if not args.keep_unreadable:
        total_u = len(report["unreadable"])
        for n, m in enumerate(report["unreadable"], 1):
            print(f"[{n}/{total_u}] re-checking unreadable: {m['path']}", file=sys.stderr)
            if (why := present(m)):
                skipped.append(("file missing or size changed", f"{m['path']}: unreadable file {why}; kept"))
            elif probe(resolve(m["path"])) is not None:
                skipped.append(("unreadable file reads fine now", f"{m['path']}: readable now; kept"))
            elif m["path"] not in seen:
                seen.add(m["path"])
                plan.append(("unreadable", m))

    total = sum(m["size"] for _, m in plan)
    action = "Removing" if args.apply else "Would remove"
    print(f"Root: {root}\n")
    for reason, m in plan:
        print(f"{action}: {m['path']}  [{human(m['size'])}]  -- {reason}")
    if skipped:
        print("\nSkipped:")
        for _, line in skipped:
            print(f"  {line}")

    def tally(items):
        counts: dict[str, list[int]] = {}
        for cat, size in items:
            c = counts.setdefault(cat, [0, 0])
            c[0] += 1
            c[1] += size
        return counts

    def category(reason: str) -> str:
        return "unreadable" if reason == "unreadable" else reason.rsplit("(", 1)[-1].rstrip(")")

    print("\n" + "=" * 60)
    print(f"SUMMARY ({'applied' if args.apply else 'dry run - nothing changed; pass --apply to do it'})")
    print(f"  {'Remove' if not args.apply else 'Removing'}: {len(plan)} file(s), {human(total)}"
          + (f"  -> moved to {args.quarantine}" if args.apply and args.quarantine else ""))
    for cat, (n, size) in sorted(tally((category(r), m["size"]) for r, m in plan).items()):
        print(f"      {n:>6}  {human(size):>10}  {cat}")
    print(f"  Kept despite matching/listed: {len(skipped)} file(s)")
    for cat, (n, _) in sorted(tally((c, 0) for c, _ in skipped).items()):
        print(f"      {n:>6}  {cat}")

    if not args.apply:
        return
    errors = 0
    for _, m in plan:
        src = resolve(m["path"])
        try:
            if args.quarantine:
                dest = args.quarantine / m["path"]
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dest))
            else:
                src.unlink()
        except OSError as e:
            errors += 1
            print(f"FAILED {m['path']}: {e}", file=sys.stderr)
    print(f"Done{f', {errors} failure(s)' if errors else ''}.")


if __name__ == "__main__":
    main()
