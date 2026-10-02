#!/usr/bin/env python3
"""Convert the four licensed Maple Mono NF CN faces to WOFF2 without subsetting.

On Windows, from the repository root:
  python -m venv "%TEMP%\boshu-fonttools-venv"
  "%TEMP%\boshu-fonttools-venv\Scripts\python.exe" -m pip install fonttools==4.59.2 brotli==1.1.0
  "%TEMP%\boshu-fonttools-venv\Scripts\python.exe" scripts/convert-fonts.py "font/code font/MapleMono-NF-CN" "font/woff2"
  rmdir /s /q "%TEMP%\boshu-fonttools-venv"

MapleHand is intentionally excluded: its supplied TTFs have no license file or
embedded copyright/license metadata establishing redistribution permission.
"""

import argparse
import shutil
from pathlib import Path

from fontTools.ttLib import TTFont


FACES = ("Regular", "Bold", "Italic", "BoldItalic")
PREFIX = "MapleMono-NF-CN"


def convert(source_dir: Path, output_dir: Path) -> None:
    license_path = source_dir / "LICENSE.txt"
    license_text = license_path.read_text(encoding="utf-8")
    if "SIL OPEN FONT LICENSE Version 1.1" not in license_text:
        raise ValueError(f"expected SIL OFL 1.1 in {license_path}")

    output_dir.mkdir(parents=True, exist_ok=True)
    for face in FACES:
        source = source_dir / f"{PREFIX}-{face}.ttf"
        target = output_dir / f"{PREFIX}-{face}.woff2"
        with TTFont(source, lazy=False) as original:
            glyphs = original.getGlyphOrder()
            cmap = original.getBestCmap()
            original.flavor = "woff2"
            original.save(target, reorderTables=False)
        with TTFont(target, lazy=False) as converted:
            if converted.flavor != "woff2":
                raise ValueError(f"not WOFF2: {target}")
            if converted.getGlyphOrder() != glyphs or converted.getBestCmap() != cmap:
                raise ValueError(f"glyphs or character map changed: {target}")
            print(
                f"{source.name}: {source.stat().st_size:,} bytes -> "
                f"{target.name}: {target.stat().st_size:,} bytes; "
                f"{len(glyphs):,} glyphs verified"
            )

    shutil.copyfile(license_path, output_dir / f"{PREFIX}-LICENSE.txt")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_dir", type=Path, help="MapleMono-NF-CN TTF directory")
    parser.add_argument("output_dir", type=Path, help="directory for WOFF2 files and license")
    args = parser.parse_args()
    convert(args.source_dir, args.output_dir)
