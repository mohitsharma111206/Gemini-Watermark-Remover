# 🎬 Clean9:16 — Pro Video Watermark Remover & 9:16 Converter

A modern, high-performance solution to remove video watermarks and convert videos into **1080×1920 (9:16 vertical)** format for TikTok, Instagram Reels, and YouTube Shorts.

**Available both as a Next.js Web App (ready for Vercel) and a high-speed Python Desktop CLI.**

---

## 🌟 Why Clean9:16? (The "Zero-Blur" Difference)

Traditional watermark removers simply smudge or blur the area where the logo was located (`delogo`), leaving an ugly foggy square on your video.

**Clean9:16 solves this with two professional approaches:**

### 1. 🌟 Smart 9:16 Reframe (0% Blur — Recommended)
- Standard horizontal videos (16:9, 4:3, 1:1) have over **68% extra horizontal width** that must be cropped when converting to vertical 9:16.
- Most watermarks (TikTok, YouTube, CapCut, Shutterstock) are located at the corners or edges.
- **Clean9:16** provides an interactive visual 9:16 framing box with **Pan (Left/Center/Right)** and **Safe Margin Zoom (1.0x - 1.4x)**.
- By panning over the main subject or applying a tiny 5-8% safe zoom, **corner watermarks are pushed completely outside the 9:16 frame**.
- Result: **100% original video clarity, 0% blur, zero artifacts, native 1080×1920**.

### 2. 🎨 Content-Aware Inpaint + Grain Match (For Center Watermarks)
- For watermarks located directly on the subject inside the 9:16 viewport:
- Instead of flat blur interpolation, Clean9:16 samples surrounding texture patterns and injects matching film grain.
- Eliminates the artificial "plastic smudge" look and blends the reconstructed patch naturally with the video.

### 3. 👁️ Live 9:16 Frame Preview
- Inspect the exact 1080×1920 output frame with watermarks removed right inside the editor before processing the full video.

---

## 🚀 Running the Web App Locally

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the dev server:
   ```bash
   npm run dev
   ```

3. Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🌐 Deploying to Vercel

The web application runs **100% in the user's browser using WebAssembly FFmpeg**.
- **Zero server load**: No GPU or expensive compute needed on Vercel.
- **100% Privacy**: Videos are never uploaded to any remote server.
- **Infinite Free Scaling**: Handles videos of any length client-side.

### Steps to Deploy:
1. Initialize and push your repository to GitHub:
   ```bash
   git add .
   git commit -m "feat: pro zero-blur watermark remover and 9:16 reframe"
   git push origin main
   ```
2. Visit [vercel.com/new](https://vercel.com/new) and import the repository.
3. Click **Deploy**. Vercel will build and host it with Cross-Origin Isolation headers automatically applied.

---

## 🐍 Python Pro Engine (Offline / Batch Processing)

For high-speed local processing of large 4K files or batch folders, use `watermark_remover_pro.py`:

```bash
# Basic 9:16 Smart Reframe with Auto-Crop
python watermark_remover_pro.py -i input.mp4 -o output_916.mp4

# Focus on subject on the left side:
python watermark_remover_pro.py -i input.mp4 -o output_916.mp4 --pan-x 0.2

# Corner watermark removal with 8% safe zoom:
python watermark_remover_pro.py -i input.mp4 -o output_916.mp4 --zoom 1.08 --wm 0.7 0.0 1.0 0.1
```

---

## 🛠️ Tech Stack

- **Framework**: Next.js 14 (App Router, React 18, TypeScript)
- **Styling**: Tailwind CSS (Dark Glassmorphic UI)
- **Web Engine**: @ffmpeg/ffmpeg (WebAssembly 0.12)
- **Local Engine**: Python 3 + OpenCV (Navier-Stokes & Lanczos resampling)
