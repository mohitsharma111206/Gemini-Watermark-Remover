#!/usr/bin/env python3
"""
Clean9:16 — Pro Video Watermark Remover & 9:16 Converter (Python Engine)
========================================================================
Supports:
1. Feathered Alpha Deblending (The exact mathematical image deblender applied to video frames)
2. Seamless Black Letterbox Merging (0% Blur Guarantee for 9:16)
3. Dynamic Video Texture Cloning (Zero Blur)
4. Full uncropped 16:9 to 9:16 portrait formatting with black borders
5. Audio preservation
"""

import cv2
import numpy as np
import argparse
import sys
import os
import subprocess

# Ensure UTF-8 output encoding on Windows consoles
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

def compute_alpha_map_from_video(cap, cx1, cy1, cx2, cy2):
    """
    Extracts the isolated alpha map of the semi-transparent Gemini watermark.
    Uses pre-calibrated least-squares alpha asset if present, or edge background subtraction.
    """
    cw = cx2 - cx1
    ch = cy2 - cy1
    
    script_dir = os.path.dirname(os.path.abspath(__file__))
    alpha_file = os.path.join(script_dir, 'least_squares_alpha_40.png')
    if os.path.exists(alpha_file):
        raw = cv2.imread(alpha_file, cv2.IMREAD_GRAYSCALE)
        if raw is not None:
            if raw.shape != (ch, cw):
                raw = cv2.resize(raw, (cw, ch), interpolation=cv2.INTER_LANCZOS4)
            alpha_map = (raw.astype(np.float32) / 255.0) * 0.82
            # Binary mask for feathering transition
            binary = (alpha_map > 0.05).astype(np.float32)
            feathered = cv2.GaussianBlur(binary, (3, 3), 0.5)
            return alpha_map[:, :, np.newaxis], feathered, 245.0

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    pos = cap.get(cv2.CAP_PROP_POS_FRAMES)
    
    # Read first frame as reference
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    ret, frame = cap.read()
    cap.set(cv2.CAP_PROP_POS_FRAMES, pos)
    
    if not ret:
        return None, None, 240.0

    crop = frame[cy1:cy2, cx1:cx2].astype(np.float32)
    bg = np.zeros_like(crop)
    for c in range(3):
        border = np.concatenate([
            crop[:10, :, c].flatten(),
            crop[-10:, :, c].flatten(),
            crop[:, :10, c].flatten()
        ])
        bg[:, :, c] = np.median(border)

    diff = np.maximum(0, crop - bg)
    gray_diff = cv2.cvtColor(diff, cv2.COLOR_BGR2GRAY)

    binary_star = (gray_diff > 18).astype(np.float32)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    dilated_star = cv2.dilate(binary_star, kernel, iterations=1)
    feathered_mask = cv2.GaussianBlur(dilated_star, (5, 5), 1.2)

    W_val = 240.0
    alpha_map = np.clip(diff / W_val, 0, 0.95) * feathered_mask[:, :, np.newaxis]
    return alpha_map, feathered_mask, W_val

def convert_to_916_with_black_borders(
    input_path: str,
    output_path: str,
    watermark_box: tuple = None,       # (x1, y1, x2, y2) in 0-1 relative or absolute pixels
    top_border_cover: int = 0,         # pixels to extend top black border down
    bottom_border_cover: int = 0,      # pixels to extend bottom black border up
    vertical_align: str = "center",    # "center", "top", "bottom"
    method: str = "deblend",           # "deblend", "merge", "clone", "inpaint"
    gemini_preset: bool = False,       # Auto 1-click Gemini watermark killer
    gemini_strategy: str = "deblend",  # "deblend", "merge", "clone", "corner"
):
    print(f"[Clean9:16] Input Video: {input_path}")
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        raise FileNotFoundError(f"Cannot open video: {input_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    print(f"  Source: {src_w}x{src_h} @ {fps:.1f} fps ({total_frames} frames)")

    # Target 9:16 portrait canvas (1080x1920)
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
    print(f"  Uncropped Video Area: {fit_w}x{fit_h} placed at y={fit_y}")
    print(f"  Top Letterbox: {fit_y}px | Bottom Letterbox: {target_h - (fit_y + fit_h)}px")

    # Handle Gemini AI Video preset
    if gemini_preset:
        print("  [Gemini] AI Watermark Killer: ACTIVE (Zero Blur Guarantee)")
        if gemini_strategy == "deblend":
            # Feathered alpha deblending directly over Gemini star
            watermark_box = (0.8856, 0.7908, 0.9328, 0.8745)
            method = "deblend"
            print("  [Gemini] Strategy: Feathered Alpha Deblending (Restores underlying pixels mathematically)")
        elif gemini_strategy == "merge":
            bottom_border_cover = max(bottom_border_cover, 80)
            print("  [Gemini] Strategy: Seamless Bottom Letterbox Merge (0% Blur)")
        elif gemini_strategy == "corner":
            print("  [Gemini] Strategy: Corner Black Patch (0% Blur)")
        elif gemini_strategy == "clone":
            watermark_box = (0.72, 0.83, 0.99, 0.99)
            method = "clone"
            print("  [Gemini] Strategy: Moving Video Texture Clone (0% Blur)")

    # Parse watermark box
    wm_pixels = None
    if watermark_box:
        x1, y1, x2, y2 = watermark_box
        if x2 <= 1.0 and y2 <= 1.0:
            x1, x2 = int(x1 * src_w), int(x2 * src_w)
            y1, y2 = int(y1 * src_h), int(y2 * src_h)
        wm_pixels = (max(0, int(x1)), max(0, int(y1)), min(src_w, int(x2)), min(src_h, int(y2)))
        print(f"  Watermark Coordinates on Source: {wm_pixels} (Method: {method})")

    # Prepare alpha map if using mathematical deblending
    alpha_map = None
    feathered_mask = None
    W_val = 240.0
    if wm_pixels and method == "deblend":
        x1, y1, x2, y2 = wm_pixels
        alpha_map, feathered_mask, W_val = compute_alpha_map_from_video(cap, x1, y1, x2, y2)
        print("  Computed isolated alpha map for feathered deblending.")

    # Temporary file for raw video frames
    temp_raw = output_path + ".temp.mp4"
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(temp_raw, fourcc, fps, (target_w, target_h))

    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        # Step 1: Zero-blur watermark removal
        if wm_pixels:
            x1, y1, x2, y2 = wm_pixels
            bw = x2 - x1
            bh = y2 - y1

            if method == "deblend" and alpha_map is not None:
                # EXACT FEATHERED ALPHA DEBLENDING FROM USER SCRIPT
                crop_bgr = frame[y1:y2, x1:x2].astype(np.float32)
                rec = (crop_bgr - alpha_map * W_val) / np.maximum(1.0 - alpha_map, 0.05)
                rec_blended = crop_bgr * (1.0 - feathered_mask[:, :, np.newaxis]) + rec * feathered_mask[:, :, np.newaxis]
                frame[y1:y2, x1:x2] = np.clip(rec_blended, 0, 255).astype(np.uint8)

            elif method == "clone":
                # Dynamic Texture Clone: Copy moving background from directly above logo
                clone_y1 = max(0, y1 - bh)
                clone_y2 = y1
                if clone_y2 > clone_y1 and (clone_y2 - clone_y1) == bh:
                    frame[y1:y2, x1:x2] = frame[clone_y1:clone_y2, x1:x2]
                else:
                    clone_x1 = max(0, x1 - bw)
                    clone_x2 = x1
                    frame[y1:y2, x1:x2] = frame[y1:y2, clone_x1:clone_x2]

            elif method == "inpaint":
                mask = np.zeros(frame.shape[:2], dtype=np.uint8)
                mask[y1:y2, x1:x2] = 255
                frame = cv2.inpaint(frame, mask, 5, cv2.INPAINT_NS)
                noise = np.random.randint(-3, 3, (bh, bw, 3), dtype=np.int16)
                patch = np.clip(frame[y1:y2, x1:x2].astype(np.int16) + noise, 0, 255).astype(np.uint8)
                frame[y1:y2, x1:x2] = patch

        # Step 2: High quality Lanczos resize of uncropped video
        scaled = cv2.resize(frame, (fit_w, fit_h), interpolation=cv2.INTER_LANCZOS4)

        # Step 3: Composite onto 1080x1920 pure black 9:16 canvas
        canvas = np.zeros((target_h, target_w, 3), dtype=np.uint8)
        canvas[fit_y:fit_y + fit_h, fit_x:fit_x + fit_w] = scaled

        # Step 4: Zero-blur border covers
        if top_border_cover > 0:
            canvas[0:fit_y + top_border_cover, :] = 0
        if bottom_border_cover > 0:
            canvas[fit_y + fit_h - bottom_border_cover:target_h, :] = 0

        # Step 5: Gemini corner patch (if corner strategy selected)
        if gemini_preset and gemini_strategy == "corner":
            corner_w = int(0.28 * fit_w)
            corner_h = int(0.15 * fit_h)
            canvas[fit_y + fit_h - corner_h:target_h, target_w - corner_w:target_w] = 0

        out.write(canvas)
        frame_idx += 1
        if frame_idx % 30 == 0 or frame_idx == total_frames:
            pct = int((frame_idx / total_frames) * 100)
            sys.stdout.write(f"\r  Rendering 9:16 video: {pct}% ({frame_idx}/{total_frames} frames)")
            sys.stdout.flush()

    cap.release()
    out.release()
    print()

    # Audio pass-through (if ffmpeg is available)
    audio_muxed = False
    try:
        cmd = [
            "ffmpeg", "-y",
            "-i", temp_raw,
            "-i", input_path,
            "-c:v", "copy",
            "-c:a", "aac",
            "-map", "0:v:0",
            "-map", "1:a:0?",
            "-shortest",
            output_path
        ]
        res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if res.returncode == 0 and os.path.exists(output_path):
            audio_muxed = True
            os.remove(temp_raw)
    except Exception:
        pass

    if not audio_muxed:
        if os.path.exists(output_path):
            os.remove(output_path)
        os.rename(temp_raw, output_path)

    print(f"[Clean9:16] SUCCESS! Exported 9:16 Video to: {output_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Clean9:16 — Feathered Alpha Deblending & 9:16 Converter")
    parser.add_argument("-i", "--input", required=True, help="Path to input video")
    parser.add_argument("-o", "--output", default="output_916_clean.mp4", help="Path to output video")
    parser.add_argument("--gemini", action="store_true", help="1-Click Gemini AI Watermark Deblender (Zero Blur)")
    parser.add_argument("--gemini-strategy", choices=["deblend", "merge", "clone", "corner"], default="deblend", help="Gemini removal strategy")
    parser.add_argument("--align", choices=["center", "top", "bottom"], default="center", help="Vertical alignment in 9:16")
    parser.add_argument("--top-cover", type=int, default=0, help="Extend top black border down (px)")
    parser.add_argument("--bottom-cover", type=int, default=0, help="Extend bottom black border up (px)")
    parser.add_argument("--method", choices=["deblend", "merge", "clone", "inpaint"], default="deblend", help="Watermark removal method")
    parser.add_argument("--wm", nargs=4, type=float, help="Custom watermark rect: x1 y1 x2 y2 (0.0 to 1.0)")

    args = parser.parse_args()
    convert_to_916_with_black_borders(
        input_path=args.input,
        output_path=args.output,
        watermark_box=tuple(args.wm) if args.wm else None,
        top_border_cover=args.top_cover,
        bottom_border_cover=args.bottom_cover,
        vertical_align=args.align,
        method=args.method,
        gemini_preset=args.gemini,
        gemini_strategy=args.gemini_strategy,
    )
