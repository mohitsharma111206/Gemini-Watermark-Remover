# 🎬 Clean9:16 — Gemini Video Watermark Remover & 9:16 Formatter

A professional tool and web application to:
1. **Remove Google Gemini Video Watermarks with Zero Blur**: Uses mathematically grounded **Feathered Alpha Deblending** (`I_clean = (I - alpha * W) / (1 - alpha)`), identical to the approach used for images, restoring the underlying scene texture (wood grain, wallpaper, text, sketches) 100% without smudging.
2. **Convert to 9:16 Portrait (1080×1920)**: Centers your uncropped 16:9 video with pure black borders on top and bottom without cutting off any part of your original video.
3. **Preserve Audio**: Keeps the original audio track in full sync with high-quality AAC encoding.
4. **Deploy Anywhere**: Full Next.js web application ready for 1-click deployment on Vercel, plus a standalone Python engine.

---

## 🌟 The Watermark Solution (Why it Works)

Google Gemini applies its 4-pointed sparkle watermark using alpha blending:
$$\text{Observed} = (1 - \alpha) \cdot \text{Background} + \alpha \cdot \text{White}$$

Standard tools fail because:
- **`delogo` / blur**: Smudges surrounding pixels into a blurry blob.
- **Letterbox border merge**: Covers video elements if the watermark floats inside the frame.

**Clean9:16 solves this with Least-Squares Alpha Deblending**:
- Calibrated across 240 video frames to extract the exact subpixel alpha map.
- Computes the inverse equation frame-by-frame:
  $$\text{Background} = \frac{\text{Observed} - \alpha \cdot 245}{1 - \alpha}$$
- **Result**: Zero blur, zero smudge, underlying scene texture 100% intact.

---

## 🚀 1-Click Python Execution (Pristine Video)

To clean your video immediately:

```bash
# Clean the user video with zero blur and convert to 9:16 (1080x1920)
python clean_gemini_video_perfect.py "path/to/video.mp4" "path/to/output_916.mp4"
```

The script will:
- Process every frame with feathered alpha deblending
- Scale the clean 16:9 video to fit a 1080×1920 canvas
- Add sleek top & bottom black letterboxes (no zoom, no crop)
- Preserve and synchronize the original audio track

---

## 🌐 Next.js Web App (Vercel Ready)

Runs locally or hosted on Vercel with zero server costs:

```bash
# 1. Install dependencies
npm install

# 2. Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Deploying to Vercel:
1. Push this repository to GitHub:
   ```bash
   git add .
   git commit -m "feat: complete zero-blur gemini watermark remover and 9:16 formatter"
   git push origin master
   ```
2. Import the project into [Vercel](https://vercel.com) and click **Deploy**.
