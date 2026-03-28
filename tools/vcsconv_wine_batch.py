#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


DEFAULT_EXE = Path("/Users/nurupo/Desktop/ps2/tools/vcsconv.exe")
DEFAULT_GAME_DAT = Path("/Users/nurupo/Desktop/ps2/GAME/GAME.dat")
DEFAULT_DIR_ROOT = Path("/Users/nurupo/Desktop/ps2/GAME")


@dataclass
class ConvertResult:
    source: str
    output: str
    ok: bool
    returncode: int
    stderr: str = ""
    archive: str = ""
    action: str = "convert"


def find_inputs(paths: list[Path], recursive: bool) -> list[Path]:
    found: list[Path] = []
    for path in paths:
        if path.is_dir():
            pattern = "**/*" if recursive else "*"
            for entry in sorted(path.glob(pattern)):
                if entry.is_file():
                    found.append(entry)
        elif path.is_file():
            found.append(path)
    return found


def parse_dir_entries(dir_path: Path) -> set[str]:
    data = dir_path.read_bytes()
    names: set[str] = set()
    for offset in range(0, len(data), 32):
        record = data[offset : offset + 32]
        if len(record) < 32:
            break
        sector_size = int.from_bytes(record[4:8], "little")
        if sector_size == 0:
            continue
        name = record[8:32].split(b"\0", 1)[0].decode("ascii", "ignore").strip()
        if name:
            names.add(name.lower())
    return names


def load_archive_sets(dir_root: Path) -> dict[str, set[str]]:
    archives: dict[str, set[str]] = {}
    for dir_path in sorted(dir_root.glob("*.dir")):
        archives[dir_path.stem.upper()] = parse_dir_entries(dir_path)
    return archives


def detect_whole_directory_archive(paths: Iterable[Path], archive_sets: dict[str, set[str]]) -> str | None:
    file_names = {path.name.lower() for path in paths}
    for archive_name, names in archive_sets.items():
        if file_names == names:
            return archive_name
    return None


def classify_source(source: Path, archive_sets: dict[str, set[str]], whole_dir_archive: str | None) -> str:
    if whole_dir_archive:
        return whole_dir_archive

    matches = [archive_name for archive_name, names in archive_sets.items() if source.name.lower() in names]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        return "AMBIGUOUS"
    return "UNKNOWN_IMG"


def get_target_path(source: Path, output_root: Path, archive_name: str) -> Path:
    target_base = output_root / archive_name / source.stem
    target_base.parent.mkdir(parents=True, exist_ok=True)
    suffix = source.suffix.lower()
    if suffix == ".xtx":
        return target_base.with_suffix(".txd")
    if suffix == ".mdl":
        return target_base.with_suffix(".dff")
    return target_base.with_suffix(source.suffix)


def convert_one(exe: Path, game_dat: Path, source: Path, output_root: Path, archive_name: str) -> ConvertResult:
    output = get_target_path(source, output_root, archive_name)

    if source.suffix.lower() == ".xtx":
        cmd = ["wine", str(exe), str(source), str(output)]
    else:
        cmd = ["wine", str(exe), "-g", str(game_dat), str(source), str(output)]

    proc = subprocess.run(cmd, capture_output=True, text=True)
    stderr = (proc.stderr or "") + (proc.stdout or "")
    return ConvertResult(
        source=str(source),
        output=str(output),
        ok=proc.returncode == 0 and output.exists(),
        returncode=proc.returncode,
        stderr=stderr.strip(),
        archive=archive_name,
        action="convert",
    )


def copy_raw(source: Path, output_root: Path, archive_name: str) -> list[ConvertResult]:
    target = get_target_path(source, output_root, archive_name)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    results = [
        ConvertResult(
            source=str(source),
            output=str(target),
            ok=True,
            returncode=0,
            stderr="",
            archive=archive_name,
            action="copy",
        )
    ]

    if source.suffix.lower() == ".col2":
        col_target = target.with_suffix(".col")
        shutil.copy2(source, col_target)
        results.append(
            ConvertResult(
                source=str(source),
                output=str(col_target),
                ok=True,
                returncode=0,
                stderr="copied from .col2",
                archive=archive_name,
                action="copy-col",
            )
        )

    return results


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Batch-convert VCS/LCS MDL/XTX files into DFF/TXD by running vcsconv.exe through wine."
    )
    parser.add_argument("inputs", nargs="+", type=Path, help="input files or directories")
    parser.add_argument("-o", "--out", type=Path, required=True, help="output directory")
    parser.add_argument("--exe", type=Path, default=DEFAULT_EXE, help="path to vcsconv.exe")
    parser.add_argument("--game-dat", type=Path, default=DEFAULT_GAME_DAT, help="path to binary GAME.dat/GTAG chunk")
    parser.add_argument("--dir-root", type=Path, default=DEFAULT_DIR_ROOT, help="directory that contains *.dir archive indexes")
    parser.add_argument("--recursive", action="store_true", help="recurse into input directories")
    parser.add_argument("--flat", action="store_true", help="do not preserve input-relative directory layout")
    parser.add_argument("--skip-existing", action="store_true", help="skip files whose output already exists")
    args = parser.parse_args()

    if shutil.which("wine") is None:
        raise SystemExit("wine not found in PATH")
    if not args.exe.exists():
        raise SystemExit(f"vcsconv.exe not found: {args.exe}")
    if not args.game_dat.exists():
        raise SystemExit(f"game.dat not found: {args.game_dat}")
    if not args.dir_root.exists():
        raise SystemExit(f"dir root not found: {args.dir_root}")

    inputs = find_inputs(args.inputs, recursive=args.recursive)
    if not inputs:
        raise SystemExit("no input files found")

    args.out.mkdir(parents=True, exist_ok=True)

    archive_sets = load_archive_sets(args.dir_root)
    whole_dir_archive = None
    if len(args.inputs) == 1 and args.inputs[0].is_dir():
        whole_dir_archive = detect_whole_directory_archive(inputs, archive_sets)

    results: list[ConvertResult] = []
    for index, source in enumerate(inputs, start=1):
        archive_name = classify_source(source, archive_sets, whole_dir_archive)
        target = get_target_path(source, args.out, archive_name)
        if args.skip_existing and target.exists():
            result = ConvertResult(
                source=str(source),
                output=str(target),
                ok=True,
                returncode=0,
                stderr="skipped existing",
                archive=archive_name,
                action="skip",
            )
            results.append(result)
            print(f"[{index}/{len(inputs)}] [skip] [{archive_name}] {source} -> {target}", flush=True)
            continue

        suffix = source.suffix.lower()
        if suffix in {".mdl", ".xtx"}:
            result = convert_one(args.exe, args.game_dat, source, args.out, archive_name)
            results.append(result)
            status = "ok" if result.ok else "fail"
            print(f"[{index}/{len(inputs)}] [{status}] [{archive_name}] {source} -> {result.output}", flush=True)
            if not result.ok and result.stderr:
                print(result.stderr, flush=True)
            continue

        copy_results = copy_raw(source, args.out, archive_name)
        results.extend(copy_results)
        printed_target = ", ".join(item.output for item in copy_results)
        print(f"[{index}/{len(inputs)}] [copy] [{archive_name}] {source} -> {printed_target}", flush=True)

    summary = {
        "input_total": len(inputs),
        "total_outputs": len(results),
        "ok": sum(1 for item in results if item.ok),
        "failed": sum(1 for item in results if not item.ok),
        "whole_dir_archive": whole_dir_archive,
        "results": [item.__dict__ for item in results],
    }
    (args.out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
