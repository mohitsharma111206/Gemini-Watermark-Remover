# 🎬 Clean9:16 — No-Crop 9:16 Black Borders & Watermark Remover

Converts horizontal (16:9, 4:3) videos to **exact 1080×1920 (9:16 vertical)** with **sleek black borders on top and bottom** — **without cropping any part of the original video** — while cleanly removing watermarks.

**Deploy to Vercel in 1-click • 100% Client-Side WebAssembly • Zero Server Costs • Python CLI included**

---

## 🌟 How It Works

### 1. ⬛ 100% Uncropped 9:16 Conversion (Letterboxing)
- **Zero Cropping**: 100% of your original video is preserved (faces, subtitles, and sides remain completely visible).
- **Standard 9:16 Dimensions**: Automatically scales your 16:9 video to fit the 1080px width, placing it in the center with top and bottom black borders (`1080×1920`), perfectly formatted for TikTok, Instagram Reels, and YouTube Shorts.
- **Vertical Alignment**: Center (default), Top, or Bottom.

### 2. 🛡️ Clean Edge Watermark Masking (0% Blur)
- If your watermark is located along the top or bottom edge of your video, you can use the **Border Cover Slider** to extend the top or bottom black border slightly (e.g. 5–30px).
- The watermark is seamlessly covered by pure black, blending perfectly into the letterbox border with **zero blur and zero visual artifacts**.

### 3. ✨ Content-Aware Inpainting with Film Grain Matching
- For watermarks located directly on the video subject:
- Inpaints the area and injects subtle matching film grain to avoid the flat, artificial "blurry smudge" look.

---

## 🚀 Running Locally

1. Start the development server:
   ```bash
   npm run dev
   ```
2. Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🌐 Deploying to Vercel

The app runs **100% in your browser using WebAssembly FFmpeg**. No videos are ever uploaded to a backend, so it runs on Vercel's free tier with zero server costs.

1. Commit and push your code to GitHub:
   ```bash
   git add .
   git commit -m "feat: complete no-crop 9:16 black borders converter"
   git push origin main
   ```
2. Go to [vercel.com/new](https://vercel.com/new) and import your repository.
3. Click **Deploy**.

---

## 🐍 Python CLI Usage

For batch processing or local offline conversion:

```bash
# Convert 16:9 to 9:16 with black borders:
python watermark_remover_pro.py -i input.mp4 -o output_916.mp4

# Cover bottom watermark by extending bottom black border up 25px:
python watermark_remover_pro.py -i input.mp4 -o output_916.mp4 --bottom-cover 25

# Mark and inpaint a watermark at bottom-right:
python watermark_remover_pro.py -i input.mp4 -o output_916.mp4 --wm 0.7 0.89 1.0 0.98
```
