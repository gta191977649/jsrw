#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import shutil
import struct
import subprocess
import tempfile
import zlib
from dataclasses import dataclass
from pathlib import Path


DEFAULT_GAME_ROOT = Path("/Users/nurupo/Desktop/ps2/GAME")
DEFAULT_ISO_ROOT = Path("/Users/nurupo/Desktop/ps2/vcs_iso")
DEFAULT_EXE = Path("/Users/nurupo/Desktop/ps2/tools/vcsconv.exe")
DEFAULT_GAME_DAT = Path("/Users/nurupo/Desktop/ps2/GAME/GAME.dat")

CHUNK_HEADER_STRUCT = struct.Struct("<IIIIIIIHH")
DIR_ENTRY_STRUCT = struct.Struct("<II24s")
AREA_INFO_STRUCT = struct.Struct("<hhIII")
WRLD_IDENT = 0x57524C44
AREA_IDENT = 0x41524541
MDL_IDENT = 0x006D646C
TEX_IDENT = 0x00746578
COL2_IDENT = 0x636F6C32


@dataclass
class ChunkHeader:
    ident: int
    shrink: int
    file_size: int
    data_size: int
    reloc_tab: int
    num_relocs: int
    global_tab: int
    num_classes: int
    num_funcs: int

    @classmethod
    def from_bytes(cls, data: bytes, offset: int = 0) -> "ChunkHeader":
        return cls(*CHUNK_HEADER_STRUCT.unpack_from(data, offset))

    def to_bytes(self) -> bytes:
        return CHUNK_HEADER_STRUCT.pack(
            self.ident,
            self.shrink,
            self.file_size,
            self.data_size,
            self.reloc_tab,
            self.num_relocs,
            self.global_tab,
            self.num_classes,
            self.num_funcs,
        )


@dataclass
class Result:
    archive: str
    source: str
    output: str
    action: str
    ok: bool
    note: str = ""


def ptr_to_data(offset: int) -> int:
    return offset - CHUNK_HEADER_STRUCT.size if offset else 0


def chunk_suffix(ident: int) -> str:
    if ident == WRLD_IDENT:
        return ".wrld"
    if ident == AREA_IDENT:
        return ".area"
    if ident == MDL_IDENT:
        return ".mdl"
    if ident == TEX_IDENT:
        return ".xtx"
    if ident == COL2_IDENT:
        return ".col2"
    return f".{ident:08x}.bin"


def find_archive_file(name: str, roots: list[Path]) -> Path:
    candidates = [name, name.upper(), name.lower()]
    for root in roots:
        for candidate in candidates:
            path = root / candidate
            if path.exists():
                return path
    raise FileNotFoundError(name)


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def run_vcsconv(exe: Path, game_dat: Path, source_name: str, data: bytes, output_path: Path) -> Result:
    ensure_parent(output_path)
    with tempfile.TemporaryDirectory(prefix="vcsconv_") as temp_dir:
        temp_source = Path(temp_dir) / source_name
        temp_source.write_bytes(data)
        if temp_source.suffix.lower() == ".xtx":
            cmd = ["wine", str(exe), str(temp_source), str(output_path)]
        else:
            cmd = ["wine", str(exe), "-g", str(game_dat), str(temp_source), str(output_path)]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        stderr = ((proc.stderr or "") + (proc.stdout or "")).strip()
    return Result(
        archive=output_path.parent.parent.name if output_path.parent.name in {"world", "interior", "areas"} else output_path.parent.name,
        source=source_name,
        output=str(output_path),
        action="convert",
        ok=proc.returncode == 0 and output_path.exists(),
        note=stderr,
    )


def write_raw(output_path: Path, data: bytes, archive: str, source_name: str, note: str = "") -> Result:
    ensure_parent(output_path)
    output_path.write_bytes(data)
    return Result(
        archive=archive,
        source=source_name,
        output=str(output_path),
        action="copy",
        ok=True,
        note=note,
    )


def write_col_variants(output_path: Path, data: bytes, archive: str, source_name: str) -> list[Result]:
    results = [write_raw(output_path, data, archive, source_name)]
    col_alias = output_path.with_suffix(".col")
    col_alias.write_bytes(data)
    results.append(
        Result(
            archive=archive,
            source=source_name,
            output=str(col_alias),
            action="copy-col",
            ok=True,
            note="copied from .col2",
        )
    )
    return results


def process_named_file(
    archive: str,
    name: str,
    data: bytes,
    output_root: Path,
    exe: Path,
    game_dat: Path,
) -> list[Result]:
    normalized = name.replace("\\", "/")
    suffix = Path(normalized).suffix.lower()
    base_output = output_root / archive / normalized
    if suffix == ".mdl":
        return [run_vcsconv(exe, game_dat, Path(normalized).name, data, base_output.with_suffix(".dff"))]
    if suffix == ".xtx":
        return [run_vcsconv(exe, game_dat, Path(normalized).name, data, base_output.with_suffix(".txd"))]
    if suffix == ".col2":
        return write_col_variants(base_output, data, archive, normalized)
    return [write_raw(base_output, data, archive, normalized)]


def extract_dir_archive(
    archive: str,
    img_path: Path,
    dir_path: Path,
    output_root: Path,
    exe: Path,
    game_dat: Path,
) -> list[Result]:
    img_bytes = img_path.read_bytes()
    dir_bytes = dir_path.read_bytes()
    results: list[Result] = []
    for offset in range(0, len(dir_bytes), DIR_ENTRY_STRUCT.size):
        record = dir_bytes[offset : offset + DIR_ENTRY_STRUCT.size]
        if len(record) < DIR_ENTRY_STRUCT.size:
            break
        sector_offset, sector_size, raw_name = DIR_ENTRY_STRUCT.unpack(record)
        if sector_size == 0:
            continue
        name = raw_name.split(b"\0", 1)[0].decode("ascii", "ignore").strip()
        if not name:
            continue
        start = sector_offset * 2048
        end = start + sector_size * 2048
        data = img_bytes[start:end]
        results.extend(process_named_file(archive, name, data, output_root, exe, game_dat))
    return results


def parse_level_manifest(lvz_path: Path) -> tuple[bytes, bytes, int, int]:
    raw = zlib.decompress(lvz_path.read_bytes())
    header = ChunkHeader.from_bytes(raw, 0)
    data = raw[CHUNK_HEADER_STRUCT.size : header.file_size]
    num_areas = struct.unpack_from("<i", data, 720)[0]
    areas_ptr = struct.unpack_from("<I", data, 724)[0]
    return raw, data, num_areas, ptr_to_data(areas_ptr)


def extract_level_archive(
    archive: str,
    img_path: Path,
    lvz_path: Path,
    output_root: Path,
    exe: Path,
    game_dat: Path,
) -> list[Result]:
    raw, data, num_areas, areas_off = parse_level_manifest(lvz_path)
    img_bytes = img_path.read_bytes()
    results: list[Result] = []

    sector_rows: list[tuple[int, int]] = []
    for index in range(36):
        sector_rows.append(struct.unpack_from("<Ii", data, 4 + index * 8))
    sector_end_header_ptr, _ = struct.unpack_from("<Ii", data, 4 + 36 * 8)
    headers_off = ptr_to_data(sector_rows[0][0])
    world_end_off = ptr_to_data(sector_end_header_ptr)
    world_count = max(0, (world_end_off - headers_off) // CHUNK_HEADER_STRUCT.size)

    total_sectors = 0
    while True:
        header_off = headers_off + total_sectors * CHUNK_HEADER_STRUCT.size
        header = ChunkHeader.from_bytes(data, header_off)
        if header.ident != WRLD_IDENT:
            break
        total_sectors += 1

    row_ranges: list[tuple[int, int, int, int]] = []
    for row_index in range(36):
        row_header_ptr, start_off = sector_rows[row_index]
        row_start = max(0, (ptr_to_data(row_header_ptr) - headers_off) // CHUNK_HEADER_STRUCT.size)
        if row_index + 1 < len(sector_rows):
            next_ptr = sector_rows[row_index + 1][0]
        else:
            next_ptr = sector_end_header_ptr
        row_end = max(row_start, (ptr_to_data(next_ptr) - headers_off) // CHUNK_HEADER_STRUCT.size)
        row_ranges.append((row_index, row_start, row_end, start_off))

    for sector_index in range(total_sectors):
        header_off = headers_off + sector_index * CHUNK_HEADER_STRUCT.size
        header = ChunkHeader.from_bytes(data, header_off)
        body_start = header.global_tab
        body_end = body_start + header.file_size - CHUNK_HEADER_STRUCT.size
        chunk = raw[header_off + CHUNK_HEADER_STRUCT.size : header_off + CHUNK_HEADER_STRUCT.size]
        assembled = header.to_bytes() + img_bytes[body_start:body_end]
        if sector_index < world_count:
            row_label = 0
            column_label = 0
            for row_index, row_start, row_end, start_off in row_ranges:
                if row_start <= sector_index < row_end:
                    row_label = row_index
                    column_label = start_off + (sector_index - row_start)
                    break
            name = f"world/y{row_label:02d}_x{column_label:02d}_s{sector_index:04d}{chunk_suffix(header.ident)}"
        else:
            name = f"interior/s{sector_index:04d}{chunk_suffix(header.ident)}"
        results.extend(process_named_file(archive, name, assembled, output_root, exe, game_dat))

    for area_index in range(num_areas):
        a, b, file_offset, file_size, num_resources = AREA_INFO_STRUCT.unpack_from(data, areas_off + area_index * AREA_INFO_STRUCT.size)
        chunk_bytes = img_bytes[file_offset : file_offset + file_size]
        header = ChunkHeader.from_bytes(chunk_bytes, 0)
        name = f"areas/a{area_index:03d}_sx{a}_sy{b}_r{num_resources}{chunk_suffix(header.ident)}"
        results.extend(process_named_file(archive, name, chunk_bytes, output_root, exe, game_dat))

    return results


def summarize(results: list[Result], output_root: Path) -> None:
    summary = {
        "total_outputs": len(results),
        "ok": sum(1 for result in results if result.ok),
        "failed": sum(1 for result in results if not result.ok),
        "results": [result.__dict__ for result in results],
    }
    (output_root / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract and convert GTA VCS PS2 IMG archives into per-archive folders.")
    parser.add_argument("-o", "--out", type=Path, required=True, help="output directory")
    parser.add_argument("--game-root", type=Path, default=DEFAULT_GAME_ROOT, help="root containing GAME.dat and base IMG/DIR files")
    parser.add_argument("--iso-root", type=Path, default=DEFAULT_ISO_ROOT, help="root containing LVZ files and extra IMG files")
    parser.add_argument("--exe", type=Path, default=DEFAULT_EXE, help="path to vcsconv.exe")
    parser.add_argument("--game-dat", type=Path, default=DEFAULT_GAME_DAT, help="path to binary GAME.dat/GTAG chunk")
    parser.add_argument(
        "--archives",
        nargs="*",
        default=["GTA3PS2", "MOCAPPS2", "BEACH", "MAINLA", "MALL"],
        help="archives to extract",
    )
    args = parser.parse_args()

    if shutil.which("wine") is None:
        raise SystemExit("wine not found in PATH")
    if not args.exe.exists():
        raise SystemExit(f"vcsconv.exe not found: {args.exe}")
    if not args.game_dat.exists():
        raise SystemExit(f"game.dat not found: {args.game_dat}")

    roots = [
        args.game_root,
        args.iso_root,
        args.iso_root / "PS2",
        args.game_root.parent / "vcs_iso",
        args.game_root.parent / "vcs_iso" / "PS2",
    ]
    args.out.mkdir(parents=True, exist_ok=True)

    results: list[Result] = []
    for archive in args.archives:
        archive_upper = archive.upper()
        print(f"== {archive_upper} ==", flush=True)
        if archive_upper in {"GTA3PS2", "MOCAPPS2"}:
            dir_name = "gta3ps2.dir" if archive_upper == "GTA3PS2" else "mocapps2.dir"
            dir_path = find_archive_file(dir_name, roots)
            img_path = find_archive_file(f"{archive_upper}.IMG", roots)
            archive_results = extract_dir_archive(archive_upper, img_path, dir_path, args.out, args.exe, args.game_dat)
        else:
            img_path = find_archive_file(f"{archive_upper}.IMG", roots)
            lvz_path = find_archive_file(f"{archive_upper}.LVZ", roots)
            archive_results = extract_level_archive(archive_upper, img_path, lvz_path, args.out, args.exe, args.game_dat)

        results.extend(archive_results)
        ok_count = sum(1 for result in archive_results if result.ok)
        fail_count = sum(1 for result in archive_results if not result.ok)
        print(f"{archive_upper}: ok={ok_count} fail={fail_count}", flush=True)

    summarize(results, args.out)
    return 0 if all(result.ok for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
