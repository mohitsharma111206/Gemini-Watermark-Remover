# 🎬 Video Watermark Remover & 9:16 Converter

A modern, high-performance web application to remove watermarks from videos and convert them into 9:16 vertical (Reels, TikTok, Shorts) format.

**100% Client-Side** • **Zero Server Costs** • **Privacy-First** • **Ready for Vercel**

---

## ✨ Key Features

- **🛡️ 100% Client-Side & Private**: All video processing happens directly in the user's browser using WebAssembly FFmpeg (`@ffmpeg/ffmpeg`). Videos are never uploaded to any server.
- **✂️ Interactive Watermark Removal**:
  - Drag-and-draw bounding box directly on video preview to select watermark area.
  - Multi-region selection (remove watermarks from multiple locations).
  - One-click presets (Top-Left, Top-Right, Bottom-Right, Bottom-Center, etc.).
  - Uses FFmpeg's `delogo` interpolation filter for seamless removal.
- **📱 9:16 Aspect Ratio Conversion**:
  - **Center Crop**: Focuses on center action and crops sides to standard 1080×1920 portrait format.
  - **Blur Fill**: Preserves entire video frame without cropping, filling top/bottom borders with an animated blurred background.
- **⚡ Audio Preservation**: Retains original audio track synchronized in high-quality AAC format.
- **📊 Real-time Progress Tracking**: Live percentage and estimated time remaining during processing.
- **🎨 Modern Dark UI**: Built with Tailwind CSS, glassmorphism cards, and smooth micro-interactions.

---

## 🚀 Running Locally

### Prerequisites
- Node.js 18.0 or newer
- npm or pnpm or yarn

### Steps

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

---

## 🌐 Deploying to Vercel

This project is tailored specifically for Vercel deployment.

### Option 1: Deploy with Git & Vercel Dashboard (Recommended)

1. Initialize Git and commit the files:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   ```
2. Push to your GitHub / GitLab / Bitbucket repository:
   ```bash
   git remote add origin https://github.com/your-username/video-watermark-remover.git
   git branch -M main
   git push -u origin main
   ```
3. Go to [vercel.com/new](https://vercel.com/new).
4. Import your repository.
5. Vercel automatically detects Next.js. Click **Deploy**.

### Option 2: Deploy using Vercel CLI

1. Install Vercel CLI (if not already installed):
   ```bash
   npm i -g vercel
   ```
2. Run deployment:
   ```bash
   vercel
   ```
3. For production deployment:
   ```bash
   vercel --prod
   ```

---

## ⚙️ Technical Architecture & Headers

To execute WebAssembly multithreaded operations in modern browsers, **SharedArrayBuffer** requires Cross-Origin Isolation headers. Both `next.config.mjs` and `vercel.json` are pre-configured with:

```json
{
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp"
}
```

FFmpeg core files (`ffmpeg-core.js` and `ffmpeg-core.wasm`) are bundled and loaded locally from `/public/ffmpeg/` with an automatic CDN fallback, guaranteeing fast load times and zero CORS hurdles.

---

## 🛠️ Tech Stack

- **Framework**: [Next.js 14](https://nextjs.org/) (App Router, React 18, TypeScript)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **Processing Engine**: [@ffmpeg/ffmpeg](https://ffmpegwasm.netlify.app/) (WebAssembly FFmpeg 0.12)
- **Deployment Target**: [Vercel](https://vercel.com/)
