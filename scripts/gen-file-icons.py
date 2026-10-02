#!/usr/bin/env python3
"""Build the Boshu file-type ICOs from their checked-in RGBA source PNGs.

The generator is intentionally small and deterministic. Run it from a throwaway
virtual environment with the pinned Pillow version, for example:

    python -m venv .tmp-file-icons
    .tmp-file-icons/Scripts/python.exe -m pip install Pillow==11.3.0
    .tmp-file-icons/Scripts/python.exe scripts/gen-file-icons.py

The virtual environment is disposable and must not be committed.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "src-tauri" / "icons"
SIZES = (16, 20, 24, 32, 40, 48, 64, 256)
SMALL_SIZES = frozenset((16, 20, 24, 32))


def prepare(source: Path, size: int) -> Image.Image:
    image = Image.open(source).convert("RGBA")
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        raise ValueError(f"source image has no visible pixels: {source}")

    # The source already has a transparent margin. Tighten it for tiny icons so
    # the file glyph remains visible after Windows scales it in Explorer.
    if size in SMALL_SIZES:
        image = image.crop(bbox)
        margin = max(1, round(max(image.size) * 0.025))
        canvas_size = max(image.size) + margin * 2
        canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
        canvas.alpha_composite(
            image,
            ((canvas_size - image.width) // 2, (canvas_size - image.height) // 2),
        )
        image = canvas

    image.thumbnail((size, size), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(image, ((size - image.width) // 2, (size - image.height) // 2))

    if size <= 32:
        canvas = canvas.filter(ImageFilter.UnsharpMask(radius=0.45, percent=115, threshold=2))
        canvas = ImageEnhance.Contrast(canvas).enhance(1.04)
    return canvas


def write_ico(source_name: str, output_name: str) -> None:
    source = ICON_DIR / source_name
    output = ICON_DIR / output_name
    images = [prepare(source, size) for size in SIZES]
    # Pillow uses the first frame as the source bounds when selecting ICO sizes;
    # put the 256px frame first while keeping all prepared smaller frames.
    images = list(reversed(images))
    # Pillow writes each requested image as a PNG-compressed ICO entry, including
    # the 256px entry needed by current Explorer high-DPI views. Passing every
    # prepared frame preserves the tiny-icon crop and sharpening above.
    images[0].save(
        output,
        format="ICO",
        sizes=[(size, size) for size in SIZES],
        append_images=images[1:],
    )
    print(f"wrote {output.relative_to(ROOT)} ({', '.join(map(str, SIZES))} px)")


def main() -> None:
    write_ico("file-code.png", "file-code.ico")
    write_ico("file-text.png", "file-text.ico")


if __name__ == "__main__":
    main()
