#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


NODE_SCRIPT = r"""
import fs from 'node:fs';
import path from 'node:path';
import { DffParser } from '__DFF_PARSER__';
import { TxdParser } from '__TXD_PARSER__';

const args = JSON.parse(process.argv[1]);
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
console.log = () => {};
console.warn = () => {};

function walkTxds(root, out = []) {
  if (!fs.existsSync(root)) return out;
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) walkTxds(full, out);
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.txd')) out.push(full);
  }
  return out;
}

function parseTxdNames(file) {
  try {
    const txd = new TxdParser().parse(fs.readFileSync(file));
    return [...txd.keys()];
  } catch {
    return [];
  }
}

const dff = new DffParser().parse(fs.readFileSync(args.dff));
const primaryNames = new Set(parseTxdNames(args.primaryTxd));
const required = new Map();

for (const geom of dff?.RWGeometryList || []) {
  for (const matWrap of geom?.RWMaterialList || []) {
    const mat = matWrap?.RWMaterial;
    const tex = String(mat?.RWTexture?.name || '').trim().toLowerCase();
    const mask = String(mat?.RWTexture?.maskName || '').trim().toLowerCase();
    if (tex) required.set(tex, { kind: 'texture', raw: mat?.RWTexture?.name || tex });
    if (mask) required.set(mask, { kind: 'mask', raw: mat?.RWTexture?.maskName || mask });
  }
}

const missing = [...required.keys()].filter((name) => !primaryNames.has(name));
const donors = new Map();
for (const root of args.searchRoots) {
  for (const txdFile of walkTxds(root)) {
    const names = parseTxdNames(txdFile);
    const hit = names.filter((name) => missing.includes(name));
    if (!hit.length) continue;
    for (const texName of hit) {
      if (!donors.has(texName)) donors.set(texName, []);
      donors.get(texName).push(txdFile);
    }
  }
}

const result = {
  dff: args.dff,
  primaryTxd: args.primaryTxd,
  requiredTextures: [...required.entries()].map(([name, meta]) => ({
    name,
    rawName: meta.raw,
    presentInPrimary: primaryNames.has(name),
    donors: donors.get(name) || [],
  })),
};

console.log = originalConsoleLog;
console.warn = originalConsoleWarn;
process.stdout.write(JSON.stringify(result, null, 2));
"""


def run_scan(dff: Path, primary_txd: Path, search_roots: list[Path]) -> dict:
    script = (
        NODE_SCRIPT.replace("__DFF_PARSER__", "/Users/nurupo/Desktop/dev/jsrw/src/lib/jsrw/formats/dff/DffParser.js")
        .replace("__TXD_PARSER__", "/Users/nurupo/Desktop/dev/jsrw/src/lib/jsrw/formats/txd/TxdParser.js")
    )
    proc = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            script,
            json.dumps(
                {
                    "dff": str(dff),
                    "primaryTxd": str(primary_txd),
                    "searchRoots": [str(root) for root in search_roots],
                }
            ),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


def main() -> int:
    parser = argparse.ArgumentParser(description="Scan a cutscene DFF/TXD pair for missing textures and collect donor TXDs.")
    parser.add_argument("dff", type=Path, help="target DFF")
    parser.add_argument("primary_txd", type=Path, help="primary TXD paired with the DFF")
    parser.add_argument("-o", "--out", type=Path, required=True, help="output bundle directory")
    parser.add_argument(
        "--search-root",
        action="append",
        dest="search_roots",
        default=[],
        help="root to scan for donor TXDs; may be specified multiple times",
    )
    args = parser.parse_args()

    default_roots = [
        Path("/Users/nurupo/Desktop/ps2/vcs_archives_by_img/GTA3PS2"),
        Path("/Users/nurupo/Desktop/ps2/ps2_gta3_by_img/GTA3PS2"),
        args.primary_txd.parent,
    ]
    search_roots: list[Path] = []
    for root in [*args.search_roots, *default_roots]:
        path = Path(root)
        if path.exists() and path not in search_roots:
            search_roots.append(path)

    report = run_scan(args.dff, args.primary_txd, search_roots)
    args.out.mkdir(parents=True, exist_ok=True)

    donor_txd_files: set[Path] = set()
    missing = []
    for entry in report["requiredTextures"]:
        if entry["presentInPrimary"]:
            continue
        donors = [Path(path) for path in entry["donors"]]
        if donors:
            donor_txd_files.add(donors[0])
        else:
            missing.append(entry["name"])

    for donor in sorted(donor_txd_files):
        target = args.out / donor.name
        if not target.exists():
            target.write_bytes(donor.read_bytes())

    summary = {
        "dff": str(args.dff),
        "primary_txd": str(args.primary_txd),
        "search_roots": [str(root) for root in search_roots],
        "donor_txd_files": [str(path) for path in sorted(donor_txd_files)],
        "missing_without_donor": missing,
        "required_textures": report["requiredTextures"],
    }
    manifest_path = args.out / "bundle_manifest.json"
    manifest_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"manifest: {manifest_path}")
    print(f"donor_txd_files: {len(donor_txd_files)}")
    if missing:
        print("missing_without_donor:")
        for name in missing:
            print(f"  {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
