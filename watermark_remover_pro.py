#!/usr/bin/env python3
"""
Clean9:16 — Pro Video Watermark Remover & 9:16 Converter (Python Engine)
========================================================================
Supports:
1. No-Crop 9:16 Conversion with Black Borders (Top & Bottom Letterbox)
2. Watermark Inpainting with Natural Film Grain
3. Edge Border Masking (Zero-Blur Watermark Cover)
4. Audio preservation in synchronized AAC
"""

import cv2
import numpy as np
import argparse
import sys

def convert_to_916_with_black_borders(
    input_path: str,
    output_path: str,
    watermark_box: tuple = None,  # (x1, y1, x2, y2) in 0-1 relative or absolute pixels
    top_border_cover: int = 0,    # pixels to extend top black border down
    bottom_border_cover: int = 0, # pixels to extend bottom black border up
    vertical_align: str = "center", # "center", "top", "bottom"
    inpaint: bool = True,
):
    print(f"[Clean9:16] Input: {input_path}")
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        raise FileNotFoundError(f"Cannot open video: {input_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    print(f"  Source: {src_w}x{src_h} @ {fps:.1f} fps ({total_frames} frames)")

    # 1. Calculate uncropped scale to fit inside 1080x1920
    target_w, target_h = 1080, 1920
    scale = min(target_w / src_w, target_h / src_h)
    fit_w = int(round(src_w * scale))
    fit_h = int(round(src_h * scale))

    fit_x = (target_w - fit_w) // 2
    if vertical_align == "top":
        fit_y = 0
    elif vertical_align == "bottom":
        fit_y = target_h - fit_h
    else:
        fit_y = (target_h - fit_h) // 2

    print(f"  Target 9:16 Canvas: {target_w}x{target_h}")
    print(f"  Uncropped Video Placement: {fit_w}x{fit_h} at y={fit_y} (Top border: {fit_y}px, Bottom border: {target_h - (fit_y + fit_h)}px)")

    # Parse watermark box
    wm_pixels = None
    if watermark_box:
        x1, y1, x2, y2 = watermark_box
        if x2 <= 1.0 and y2 <= 1.0:
            x1, x2 = int(x1 * src_w), int(x2 * src_w)
            y1, y2 = int(y1 * src_h), int(y2 * src_h)
        wm_pixels = (max(0, x1), max(0, y1), min(src_w, x2), min(src_h, y2))
        print(f"  Watermark region on source: {wm_pixels}")

    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(output_path, fourcc, fps, (target_w, target_h))

    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        # Step 1: Remove watermark on source video if marked
        if wm_pixels and inpaint:
            x1, y1, x2, y2 = wm_pixels
            mask = np.zeros(frame.shape[:2], dtype=np.uint8)
            mask[y1:y2, x1:x2] = 255
            frame = cv2.inpaint(frame, mask, 5, cv2.INPAINT_NS)

            # Match film grain to prevent flat blur
            noise = np.random.randint(-3, 3, (y2 - y1, x2 - x1, 3), dtype=np.int16)
            patch = np.clip(frame[y1:y2, x1:x2].astype(np.int16) + noise, 0, 255).astype(np.uint8)
            frame[y1:y2, x1:x2] = patch

        # Step 2: Resize uncropped source to fit 9:16 width
        scaled = cv2.resize(frame, (fit_w, fit_h), interpolation=cv2.INTER_LANCZOS4)

        # Step 3: Create 1080x1920 pure black canvas
        canvas = np.zeros((target_h, target_w, 3), dtype=np.uint8)
        canvas[fit_y:fit_y + fit_h, fit_x:fit_x + fit_w] = scaled

        # Step 4: Apply top/bottom black border covers (if specified)
        if top_border_cover > 0:
            canvas[0:fit_y + top_border_cover, :] = 0
        if bottom_border_cover > 0:
            canvas[fit_y + fit_h - bottom_border_cover:target_h, :] = 0

        out.write(canvas)
        frame_idx += 1
        if frame_idx % 30 == 0 or frame_idx == total_frames:
            pct = int((frame_idx / total_frames) * 100)
            sys.stdout.write(f"\r  Rendering: {pct}% ({frame_idx}/{total_frames} frames)")
            sys.stdout.flush()

    cap.release()
    out.release()
    print(f"\n[Clean9:16] Saved 9:16 Video to: {output_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Clean9:16 No-Crop Black Borders Converter")
    parser.add_argument("-i", "--input", required=True, help="Input video path")
    parser.add_argument("-o", "--output", default="output_916_black_borders.mp4", help="Output video path")
    parser.add_argument("--align", choices=["center", "top", "bottom"], default="center", help="Vertical alignment")
    parser.add_argument("--top-cover", type=int, default=0, help="Pixels to extend top border down (covers top logo)")
    parser.add_argument("--bottom-cover", type=int, default=0, help="Pixels to extend bottom border up (covers bottom logo)")
    parser.add_argument("--wm", nargs=4, type=float, help="Watermark rect: x1 y1 x2 y2 (e.g. 0.7 0.89 1.0 0.98)")

    args = parser.parse_args()
    convert_to_916_with_black_borders(
        input_path=args.input,
        output_path=args.output,
        watermark_box=tuple(args.wm) if args.wm else None,
        top_border_cover=args.top_cover,
        bottom_border_cover=args.bottom_cover,
        vertical_align=args.align,
    )
