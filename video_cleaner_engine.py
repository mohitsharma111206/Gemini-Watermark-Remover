import cv2
import numpy as np
import subprocess
import shutil
import os
import sys

def find_watermark_in_frame(frame):
    h, w = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    
    # Search in bottom right corner (last 35% of width, last 35% of height)
    y_start = int(h * 0.65)
    x_start = int(w * 0.65)
    search_region = gray[y_start:h, x_start:w]
    
    best_score = -1
    best_match = None
    
    templates = {
        36: "gemini-watermark-and-synthid-remover/assets/watermark-masks/gemini-3.5-diamond-36px.png",
        48: "gemini-watermark-and-synthid-remover/assets/watermark-masks/gemini-3.6-diamond-48px.png",
        40: "least_squares_alpha_40.png"
    }
    
    for size, path in templates.items():
        if not os.path.exists(path):
            continue
        tpl = cv2.imread(path, cv2.IMREAD_UNCHANGED)
        if len(tpl.shape) == 3:
            tpl_gray = tpl[:, :, 3] if tpl.shape[2] == 4 else cv2.cvtColor(tpl, cv2.COLOR_BGR2GRAY)
        else:
            tpl_gray = tpl
        
        th, tw = tpl_gray.shape[:2]
        res = cv2.matchTemplate(search_region, tpl_gray, cv2.TM_CCOEFF_NORMED)
        min_v, max_v, min_l, max_l = cv2.minMaxLoc(res)
        
        if max_v > best_score:
            best_score = max_v
            best_match = {
                "x": x_start + max_l[0],
                "y": y_start + max_l[1],
                "w": tw,
                "h": th,
                "score": max_v,
                "size": size
            }
            
    return best_match

def process_video_clean(input_path, output_path, progress_cb=None):
    cap = cv2.VideoCapture(input_path)
    if not cap.isOpened():
        raise RuntimeError("Cannot open input video")
        
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    
    ret, frame0 = cap.read()
    if not ret:
        raise RuntimeError("Cannot read first frame")
        
    match = find_watermark_in_frame(frame0)
    print(f"Detected watermark match: {match}")
    
    # Coordinates of diamond
    # In 848x478, center is (768, 398), size ~44
    if match and match["score"] > 0.35:
        mx = match["x"]
        my = match["y"]
        mw = match["w"]
        mh = match["h"]
        # Center:
        cx = mx + mw // 2
        cy = my + mh // 2
    else:
        # Fallback to standard relative corner: cx ~ 0.905*w, cy ~ 0.832*h
        cx = int(w * 0.905)
        cy = int(h * 0.832)
        
    # We want a diamond mask centered at (cx, cy)
    box_size = int(round(min(w, h) * 0.08))  # ~38-42px
    box_size = max(36, min(box_size, 96))
    if box_size % 2 != 0:
        box_size += 1
        
    x1 = max(0, cx - box_size // 2)
    y1 = max(0, cy - box_size // 2)
    x2 = min(w, x1 + box_size)
    y2 = min(h, y1 + box_size)
    bw = x2 - x1
    bh = y2 - y1
    
    print(f"Watermark region: ({x1}, {y1}) to ({x2}, {y2}), size: {bw}x{bh}")
    
    # Build mask
    mask_full = np.zeros((h, w), dtype=np.uint8)
    alpha_raw = cv2.imread("least_squares_alpha_40.png", cv2.IMREAD_GRAYSCALE)
    if alpha_raw is not None:
        alpha_resized = cv2.resize(alpha_raw, (bw, bh))
        binary = (alpha_resized > 10).astype(np.uint8) * 255
        dilated = cv2.dilate(binary, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
        mask_full[y1:y2, x1:x2] = dilated
    else:
        cv2.circle(mask_full, (cx, cy), box_size // 2, 255, -1)
        
    # Reset video pos
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    
    temp_raw = output_path + ".temp.mp4"
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(temp_raw, fourcc, fps, (w, h))
    
    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
            
        # Inpaint watermark seamlessly
        clean_frame = cv2.inpaint(frame, mask_full, 3, cv2.INPAINT_TELEA)
        out.write(clean_frame)
        
        frame_idx += 1
        if progress_cb and (frame_idx % 12 == 0 or frame_idx == total_frames):
            pct = int((frame_idx / total_frames) * 100)
            progress_cb(frame_idx, total_frames, pct)
            
    cap.release()
    out.release()
    
    # FFmpeg remux with audio
    # Locate ffmpeg
    from clean_gemini_video_perfect import get_ffmpeg_path
    ffmpeg_bin = get_ffmpeg_path()
    
    probe = subprocess.run([ffmpeg_bin, '-i', input_path, '-hide_banner'], stderr=subprocess.PIPE, text=True)
    has_audio = ('Audio:' in probe.stderr)
    
    if os.path.exists(output_path):
        try: os.remove(output_path)
        except Exception: pass
        
    if has_audio:
        cmd = [
            ffmpeg_bin, '-y',
            '-i', temp_raw,
            '-i', input_path,
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-preset', 'fast',
            '-crf', '16',
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-shortest',
            output_path
        ]
    else:
        cmd = [
            ffmpeg_bin, '-y',
            '-i', temp_raw,
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-preset', 'fast',
            '-crf', '16',
            output_path
        ]
        
    subprocess.run(cmd, capture_output=True, text=True)
    if os.path.exists(temp_raw):
        os.remove(temp_raw)
        
    print(f"Video cleaning complete: {output_path} ({os.path.getsize(output_path)} bytes)")

if __name__ == "__main__":
    process_video_clean(
        "uploads/5cbcbace-677d-452f-947e-490413e54984_input.mp4",
        "output_clean_flawless.mp4",
        lambda f, t, p: print(f"Frame {f}/{t} ({p}%)")
    )
