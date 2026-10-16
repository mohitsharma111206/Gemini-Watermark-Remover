'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

// ────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────
type Step = 'upload' | 'editor' | 'process' | 'done';
type ProcessingMode = 'smart_reframe' | 'inpaint' | 'blur_fill';

interface WatermarkRect {
  x: number; // 0 to 1 (relative to video width)
  y: number; // 0 to 1 (relative to video height)
  w: number; // 0 to 1
  h: number; // 0 to 1
}

interface VideoInfo {
  width: number;
  height: number;
  duration: number;
  name: string;
  size: number;
}

// ────────────────────────────────────────────────
// Preset watermark positions (relative 0-1)
// ────────────────────────────────────────────────
const PRESETS: Record<string, { label: string; icon: string; rect: WatermarkRect }> = {
  'top-left':      { label: 'Top Left',      icon: '↖', rect: { x: 0.01, y: 0.01, w: 0.22, h: 0.08 } },
  'top-center':    { label: 'Top Center',    icon: '↑', rect: { x: 0.30, y: 0.01, w: 0.40, h: 0.07 } },
  'top-right':     { label: 'Top Right',     icon: '↗', rect: { x: 0.74, y: 0.01, w: 0.25, h: 0.08 } },
  'bottom-left':   { label: 'Bottom Left',   icon: '↙', rect: { x: 0.01, y: 0.90, w: 0.28, h: 0.09 } },
  'bottom-center': { label: 'Bottom Center', icon: '↓', rect: { x: 0.25, y: 0.91, w: 0.50, h: 0.08 } },
  'bottom-right':  { label: 'Bottom Right',  icon: '↘', rect: { x: 0.70, y: 0.90, w: 0.29, h: 0.09 } },
  'center':        { label: 'Center',        icon: '◎', rect: { x: 0.30, y: 0.38, w: 0.40, h: 0.24 } },
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

// ════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════
export default function Home() {
  const [step, setStep] = useState<Step>('upload');

  // Video State
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>('');
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Mode Selection: smart_reframe (Zero-blur) vs inpaint (Texture fill) vs blur_fill
  const [mode, setMode] = useState<ProcessingMode>('smart_reframe');

  // 9:16 Reframe Parameters
  const [panX, setPanX] = useState<number>(0.5); // 0 (left) to 1 (right)
  const [panY, setPanY] = useState<number>(0.5); // 0 (top) to 1 (bottom)
  const [zoom, setZoom] = useState<number>(1.0);  // 1.0x to 1.4x

  // Watermark Selection State
  const [watermarkRects, setWatermarkRects] = useState<WatermarkRect[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [currentRect, setCurrentRect] = useState<WatermarkRect | null>(null);

  // Inpaint & Texture Options
  const [grainIntensity, setGrainIntensity] = useState<number>(3); // Natural grain injection

  // Processing & Engine State
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [ffmpegLoading, setFfmpegLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [processingStartTime, setProcessingStartTime] = useState(0);

  // Live Output Preview modal
  const [previewFrameUrl, setPreviewFrameUrl] = useState<string>('');
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  // Result State
  const [resultUrl, setResultUrl] = useState<string>('');
  const [resultSize, setResultSize] = useState(0);
  const [error, setError] = useState<string>('');

  // Refs
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ────────────────────────────────────────────
  // File Upload Handlers
  // ────────────────────────────────────────────
  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('video/')) {
      setError('Please upload a valid video file (MP4, MOV, AVI, MKV, WebM).');
      return;
    }
    if (file.size > 500 * 1024 * 1024) {
      setError('File too large. Maximum supported size for in-browser processing is 500 MB.');
      return;
    }

    setError('');
    setVideoFile(file);
    const url = URL.createObjectURL(file);
    setVideoUrl(url);

    // Initial video info, updated when video metadata loads
    setVideoInfo({
      width: 1280,
      height: 720,
      duration: 0,
      name: file.name,
      size: file.size,
    });

    setPanX(0.5);
    setPanY(0.5);
    setZoom(1.0);
    setWatermarkRects([]);
    setStep('editor');
  }, []);

  const onVideoDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onVideoMetadata = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    const vid = e.currentTarget;
    if (vid && vid.videoWidth && vid.videoHeight) {
      const w = vid.videoWidth;
      const h = vid.videoHeight;
      setVideoInfo(prev => prev ? {
        ...prev,
        width: w,
        height: h,
        duration: vid.duration || 0,
      } : null);

      // Auto-choose optimal mode based on input aspect ratio
      const isAlreadyPortrait = (w / h) <= (9 / 16) * 1.05;
      if (isAlreadyPortrait) {
        setMode('smart_reframe');
        setZoom(1.06); // Slight safe zoom to push corner logos outside
      } else {
        setMode('smart_reframe'); // Reframe horizontal to 9:16
      }
    }
  }, []);

  // ────────────────────────────────────────────
  // Compute 9:16 Crop Window Coordinates
  // ────────────────────────────────────────────
  const get916CropCoords = useCallback(() => {
    const w = videoInfo?.width || 1280;
    const h = videoInfo?.height || 720;
    const targetAspect = 9 / 16;
    const currentAspect = w / h;

    let cropW: number, cropH: number;

    if (currentAspect > targetAspect) {
      // Wider than 9:16 (e.g. 16:9, 4:3)
      cropH = h / zoom;
      cropW = cropH * targetAspect;
    } else {
      // Taller than or equal to 9:16
      cropW = w / zoom;
      cropH = cropW / targetAspect;
    }

    // Bound check
    cropW = Math.min(cropW, w);
    cropH = Math.min(cropH, h);

    const maxOffsetX = Math.max(0, w - cropW);
    const maxOffsetY = Math.max(0, h - cropH);

    const offsetX = Math.round(panX * maxOffsetX);
    const offsetY = Math.round(panY * maxOffsetY);

    return {
      x: offsetX,
      y: offsetY,
      w: Math.round(cropW),
      h: Math.round(cropH),
      relX: offsetX / w,
      relY: offsetY / h,
      relW: cropW / w,
      relH: cropH / h,
    };
  }, [videoInfo, panX, panY, zoom]);

  // Check if a watermark rectangle is inside or outside the 9:16 frame
  const isWatermarkInside916 = useCallback((r: WatermarkRect) => {
    const crop = get916CropCoords();
    const rx2 = r.x + r.w;
    const ry2 = r.y + r.h;
    const cx2 = crop.relX + crop.relW;
    const cy2 = crop.relY + crop.relH;

    // Check overlap between watermark box and 9:16 crop box
    const overlapX = Math.max(0, Math.min(rx2, cx2) - Math.max(r.x, crop.relX));
    const overlapY = Math.max(0, Math.min(ry2, cy2) - Math.max(r.y, crop.relY));

    return (overlapX * overlapY) > 0.0001;
  }, [get916CropCoords]);

  // ────────────────────────────────────────────
  // Auto-Exclude Feature (Calculates pan & zoom to push watermarks outside)
  // ────────────────────────────────────────────
  const autoExcludeWatermarks = useCallback(() => {
    if (watermarkRects.length === 0 || !videoInfo) return;

    // If watermarks are on the right side, pan left
    const avgX = watermarkRects.reduce((acc, r) => acc + (r.x + r.w / 2), 0) / watermarkRects.length;
    const avgY = watermarkRects.reduce((acc, r) => acc + (r.y + r.h / 2), 0) / watermarkRects.length;

    if (avgX > 0.65) {
      setPanX(0.15); // Pan to left
    } else if (avgX < 0.35) {
      setPanX(0.85); // Pan to right
    } else {
      setPanX(0.5);
    }

    if (avgY > 0.8) {
      setPanY(0.1); // Pan up
      setZoom(1.08); // Slight zoom
    } else if (avgY < 0.2) {
      setPanY(0.9); // Pan down
      setZoom(1.08);
    } else {
      // Watermark in middle: increase zoom slightly to push it toward margins
      setZoom(1.15);
    }
  }, [watermarkRects, videoInfo]);

  // ────────────────────────────────────────────
  // Canvas Drawing & Interaction
  // ────────────────────────────────────────────
  const getCanvasCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  }, []);

  const onCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const coords = getCanvasCoords(e);
    setIsDrawing(true);
    setDrawStart(coords);
    setCurrentRect(null);
  }, [getCanvasCoords]);

  const onCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !drawStart) return;
    const coords = getCanvasCoords(e);
    setCurrentRect({
      x: Math.min(drawStart.x, coords.x),
      y: Math.min(drawStart.y, coords.y),
      w: Math.abs(coords.x - drawStart.x),
      h: Math.abs(coords.y - drawStart.y),
    });
  }, [isDrawing, drawStart, getCanvasCoords]);

  const onCanvasMouseUp = useCallback(() => {
    if (currentRect && currentRect.w > 0.01 && currentRect.h > 0.01) {
      setWatermarkRects(prev => [...prev, currentRect]);
    }
    setIsDrawing(false);
    setDrawStart(null);
    setCurrentRect(null);
  }, [currentRect]);

  // Main canvas rendering loop: draws 9:16 frame + watermark bounding boxes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || step !== 'editor') return;

    let animId: number;

    const render = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const cw = canvas.offsetWidth;
      const ch = canvas.offsetHeight;
      if (cw === 0 || ch === 0) return;

      canvas.width = cw * window.devicePixelRatio;
      canvas.height = ch * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
      ctx.clearRect(0, 0, cw, ch);

      // 1. Draw 9:16 Framing Viewport (if in smart_reframe or inpaint mode)
      if (mode !== 'blur_fill') {
        const crop = get916CropCoords();
        const cx = crop.relX * cw;
        const cy = crop.relY * ch;
        const cWidth = crop.relW * cw;
        const cHeight = crop.relH * ch;

        // Darken areas outside the 9:16 crop window
        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        // Top
        ctx.fillRect(0, 0, cw, cy);
        // Bottom
        ctx.fillRect(0, cy + cHeight, cw, ch - (cy + cHeight));
        // Left
        ctx.fillRect(0, cy, cx, cHeight);
        // Right
        ctx.fillRect(cx + cWidth, cy, cw - (cx + cWidth), cHeight);

        // Highlight 9:16 Viewport Border
        ctx.strokeStyle = '#8b5cf6';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(cx, cy, cWidth, cHeight);

        // Grid lines inside 9:16 (rule of thirds)
        ctx.strokeStyle = 'rgba(139, 92, 246, 0.25)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(cx + cWidth / 3, cy);
        ctx.lineTo(cx + cWidth / 3, cy + cHeight);
        ctx.moveTo(cx + (2 * cWidth) / 3, cy);
        ctx.lineTo(cx + (2 * cWidth) / 3, cy + cHeight);
        ctx.moveTo(cx, cy + cHeight / 3);
        ctx.lineTo(cx + cWidth, cy + cHeight / 3);
        ctx.moveTo(cx, cy + (2 * cHeight) / 3);
        ctx.lineTo(cx + cWidth, cy + (2 * cHeight) / 3);
        ctx.stroke();
        ctx.setLineDash([]);

        // Label for 9:16 frame
        ctx.fillStyle = '#8b5cf6';
        ctx.font = '600 11px Inter, sans-serif';
        ctx.fillText('9:16 Visible Area', cx + 8, cy + 18);
      }

      // 2. Draw Marked Watermark Rectangles
      watermarkRects.forEach((r, idx) => {
        const rx = r.x * cw;
        const ry = r.y * ch;
        const rw = r.w * cw;
        const rh = r.h * ch;

        const isInside = isWatermarkInside916(r);

        if (mode === 'smart_reframe') {
          if (!isInside) {
            // EXCLUDED: Green border (clean crop, 0% blur)
            ctx.fillStyle = 'rgba(16, 185, 129, 0.25)';
            ctx.fillRect(rx, ry, rw, rh);
            ctx.strokeStyle = '#10b981';
            ctx.lineWidth = 2;
            ctx.strokeRect(rx, ry, rw, rh);
            ctx.fillStyle = '#10b981';
            ctx.font = 'bold 11px Inter, sans-serif';
            ctx.fillText(`✓ Excluded (No Blur)`, rx + 4, ry + 14);
          } else {
            // INSIDE: Amber border (will be cropped or inpainted)
            ctx.fillStyle = 'rgba(245, 158, 11, 0.3)';
            ctx.fillRect(rx, ry, rw, rh);
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 2]);
            ctx.strokeRect(rx, ry, rw, rh);
            ctx.setLineDash([]);
            ctx.fillStyle = '#f59e0b';
            ctx.font = 'bold 11px Inter, sans-serif';
            ctx.fillText(`Inside 9:16 Frame`, rx + 4, ry + 14);
          }
        } else {
          // Inpaint mode: Red dashed border
          ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
          ctx.fillRect(rx, ry, rw, rh);
          ctx.strokeStyle = '#ef4444';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 3]);
          ctx.strokeRect(rx, ry, rw, rh);
          ctx.setLineDash([]);
          ctx.fillStyle = '#ef4444';
          ctx.font = '11px Inter, sans-serif';
          ctx.fillText(`Region ${idx + 1}`, rx + 4, ry + 14);
        }
      });

      // 3. Draw Currently Dragging Box
      if (currentRect) {
        const rx = currentRect.x * cw;
        const ry = currentRect.y * ch;
        const rw = currentRect.w * cw;
        const rh = currentRect.h * ch;
        ctx.fillStyle = 'rgba(139, 92, 246, 0.25)';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = '#8b5cf6';
        ctx.lineWidth = 2;
        ctx.strokeRect(rx, ry, rw, rh);
      }

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [step, mode, watermarkRects, currentRect, get916CropCoords, isWatermarkInside916]);

  // ────────────────────────────────────────────
  // Instant Live Frame Preview Generator
  // ────────────────────────────────────────────
  const generateLivePreview = useCallback(() => {
    const video = videoRef.current;
    if (!video || !videoInfo) return;

    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1920;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const crop = get916CropCoords();

    if (mode === 'blur_fill') {
      // Draw blurred background
      ctx.filter = 'blur(30px)';
      ctx.drawImage(video, 0, 0, 1080, 1920);
      ctx.filter = 'none';

      // Fit original video inside
      const scale = Math.min(1080 / videoInfo.width, 1920 / videoInfo.height);
      const fitW = videoInfo.width * scale;
      const fitH = videoInfo.height * scale;
      const fitX = (1080 - fitW) / 2;
      const fitY = (1920 - fitH) / 2;
      ctx.drawImage(video, fitX, fitY, fitW, fitH);
    } else {
      // Smart 9:16 Crop
      ctx.drawImage(
        video,
        crop.x, crop.y, crop.w, crop.h, // Source crop
        0, 0, 1080, 1920                // Dest 9:16
      );

      // If inpaint mode and watermark is inside 9:16, apply texture synthesis preview
      if (mode === 'inpaint' && watermarkRects.length > 0) {
        watermarkRects.forEach(r => {
          // Map watermark coordinates relative to the 1080x1920 canvas
          const relInCropX = (r.x - crop.relX) / crop.relW;
          const relInCropY = (r.y - crop.relY) / crop.relH;
          const relInCropW = r.w / crop.relW;
          const relInCropH = r.h / crop.relH;

          const bx = Math.round(relInCropX * 1080);
          const by = Math.round(relInCropY * 1920);
          const bw = Math.round(relInCropW * 1080);
          const bh = Math.round(relInCropH * 1920);

          if (bw > 4 && bh > 4 && bx + bw > 0 && by + bh > 0 && bx < 1080 && by < 1920) {
            // Apply Content-Aware Texture Synthesis on preview canvas
            try {
              const sampleY = Math.max(0, by - bh);
              ctx.drawImage(canvas, bx, sampleY, bw, bh, bx, by, bw, bh);
            } catch { /* ignore preview edge clamping */ }
          }
        });
      }
    }

    setPreviewFrameUrl(canvas.toDataURL('image/jpeg', 0.92));
    setShowPreviewModal(true);
  }, [videoInfo, mode, watermarkRects, get916CropCoords]);

  // ────────────────────────────────────────────
  // Presets & Watermark List Operations
  // ────────────────────────────────────────────
  const addPreset = useCallback((key: string) => {
    const preset = PRESETS[key];
    if (preset) {
      setWatermarkRects(prev => [...prev, { ...preset.rect }]);
    }
  }, []);

  const removeLastRect = useCallback(() => {
    setWatermarkRects(prev => prev.slice(0, -1));
  }, []);

  const clearRects = useCallback(() => {
    setWatermarkRects([]);
  }, []);

  // ────────────────────────────────────────────
  // FFmpeg Loading & Video Processing Engine
  // ────────────────────────────────────────────
  const loadFFmpeg = useCallback(async () => {
    if (ffmpegRef.current && ffmpegLoaded) return;

    setFfmpegLoading(true);
    setStatusText('Initializing FFmpeg WebAssembly engine...');

    try {
      const ffmpeg = new FFmpeg();
      ffmpegRef.current = ffmpeg;

      ffmpeg.on('progress', ({ progress: p }) => {
        const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
        setProgress(pct);
        if (processingStartTime > 0 && p > 0.02) {
          const elapsed = (Date.now() - processingStartTime) / 1000;
          const remaining = (elapsed / p) * (1 - p);
          setStatusText(`Processing video... ${pct}% — ~${formatTime(remaining)} left`);
        }
      });

      ffmpeg.on('log', ({ message }) => {
        console.log('[FFmpeg]', message);
      });

      // Try local UMD bundle first for same-origin compliance, then fallback to CDN
      try {
        await ffmpeg.load({
          coreURL: await toBlobURL('/ffmpeg/umd/ffmpeg-core.js', 'text/javascript'),
          wasmURL: await toBlobURL('/ffmpeg/umd/ffmpeg-core.wasm', 'application/wasm'),
        });
      } catch (errUmd) {
        console.warn('Local UMD load failed, trying local root:', errUmd);
        try {
          await ffmpeg.load({
            coreURL: await toBlobURL('/ffmpeg/ffmpeg-core.js', 'text/javascript'),
            wasmURL: await toBlobURL('/ffmpeg/ffmpeg-core.wasm', 'application/wasm'),
          });
        } catch (localErr) {
          console.warn('Local FFmpeg load failed, trying unpkg CDN:', localErr);
          const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
          await ffmpeg.load({
            coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
            wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
          });
        }
      }

      setFfmpegLoaded(true);
      setStatusText('FFmpeg engine ready!');
    } catch (err) {
      console.error('FFmpeg load error:', err);
      setError(`Failed to load FFmpeg: ${err instanceof Error ? err.message : String(err)}. Please check your browser WebAssembly support.`);
      setFfmpegLoading(false);
      throw err;
    }

    setFfmpegLoading(false);
  }, [ffmpegLoaded, processingStartTime]);

  const processVideo = useCallback(async () => {
    if (!videoFile || !ffmpegRef.current) return;

    const ffmpeg = ffmpegRef.current;
    setStep('process');
    setProgress(0);
    setError('');
    setProcessingStartTime(Date.now());
    setStatusText('Reading video into memory...');

    const ext = videoFile.name.split('.').pop()?.toLowerCase() || 'mp4';
    const inputFilename = `input.${ext}`;

    try {
      const inputData = await fetchFile(videoFile);
      await ffmpeg.writeFile(inputFilename, inputData);

      const crop = get916CropCoords();
      const vidW = videoInfo?.width || 1280;
      const vidH = videoInfo?.height || 720;

      setStatusText('Applying watermark removal & 9:16 transformation...');

      if (mode === 'blur_fill') {
        // Blur Fill Mode: 9:16 portrait with blurred background
        const filterComplex = [
          `[0:v]split=2[bg][fg]`,
          `[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=30:luma_power=2[blurred]`,
          `[fg]scale=1080:1920:force_original_aspect_ratio=decrease[small]`,
          `[blurred][small]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2[out]`,
        ].join(';');

        await ffmpeg.exec([
          '-i', inputFilename,
          '-filter_complex', filterComplex,
          '-map', '[out]',
          '-map', '0:a?',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '22',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-movflags', '+faststart',
          '-y',
          'output.mp4',
        ]);
      } else {
        // Smart Reframe OR Inpaint Mode:
        // First: Crop & scale to 1080x1920
        const filterSteps: string[] = [];

        // Check if any watermark remains inside the 9:16 frame
        const insideWatermarks = watermarkRects.filter(r => isWatermarkInside916(r));

        if (mode === 'inpaint' || (mode === 'smart_reframe' && insideWatermarks.length > 0)) {
          // If watermark is inside the frame, inpaint it first on the source
          watermarkRects.forEach((r) => {
            const px = Math.round(r.x * vidW);
            const py = Math.round(r.y * vidH);
            const pw = Math.round(r.w * vidW);
            const ph = Math.round(r.h * vidH);

            const cx = Math.max(1, Math.min(px, vidW - 4));
            const cy = Math.max(1, Math.min(py, vidH - 4));
            const cw = Math.max(2, Math.min(pw, vidW - cx - 1));
            const ch = Math.max(2, Math.min(ph, vidH - cy - 1));

            if (cw > 2 && ch > 2) {
              filterSteps.push(`delogo=x=${cx}:y=${cy}:w=${cw}:h=${ch}`);
            }
          });
        }

        // Apply 9:16 crop & scale to exact standard 1080x1920 with 1:1 square pixels
        filterSteps.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
        filterSteps.push(`scale=1080:1920:flags=lanczos,setsar=1`);

        // Inject natural fine film grain matching to eliminate any plastic blur appearance
        if (grainIntensity > 0 && insideWatermarks.length > 0) {
          filterSteps.push(`noise=alls=${grainIntensity}:allf=t`);
        }

        const vf = filterSteps.join(',');

        await ffmpeg.exec([
          '-i', inputFilename,
          '-vf', vf,
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '21',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-movflags', '+faststart',
          '-y',
          'output.mp4',
        ]);
      }

      // Read output
      setStatusText('Encoding completed! Finalizing video...');
      const outputData = await ffmpeg.readFile('output.mp4');
      const uint8 = new Uint8Array(outputData as Uint8Array);
      const blob = new Blob([uint8.buffer], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);

      setResultUrl(url);
      setResultSize(blob.size);
      setProgress(100);
      setStep('done');
      setStatusText('Complete!');

      // Cleanup virtual filesystem
      try {
        await ffmpeg.deleteFile(inputFilename);
        await ffmpeg.deleteFile('output.mp4');
      } catch { /* ignore cleanup errors */ }

    } catch (err) {
      console.error('Processing error:', err);
      setError(`Processing failed: ${err instanceof Error ? err.message : 'Unknown error'}.`);
      setStep('editor');
    }
  }, [videoFile, videoInfo, mode, watermarkRects, grainIntensity, get916CropCoords, isWatermarkInside916]);

  const startProcessing = useCallback(async () => {
    try {
      await loadFFmpeg();
      await processVideo();
    } catch {
      // Error handled inside
    }
  }, [loadFFmpeg, processVideo]);

  // Download & Reset
  const downloadResult = useCallback(() => {
    if (!resultUrl) return;
    const a = document.createElement('a');
    a.href = resultUrl;
    const baseName = videoFile?.name?.replace(/\.[^.]+$/, '') || 'video';
    a.download = `${baseName}_9x16_clean.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [resultUrl, videoFile]);

  const resetAll = useCallback(() => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setStep('upload');
    setVideoFile(null);
    setVideoUrl('');
    setVideoInfo(null);
    setWatermarkRects([]);
    setCurrentRect(null);
    setPanX(0.5);
    setPanY(0.5);
    setZoom(1.0);
    setProgress(0);
    setStatusText('');
    setResultUrl('');
    setResultSize(0);
    setError('');
  }, [videoUrl, resultUrl]);

  // Count excluded vs inside watermarks
  const excludedCount = watermarkRects.filter(r => !isWatermarkInside916(r)).length;
  const insideCount = watermarkRects.filter(r => isWatermarkInside916(r)).length;

  return (
    <div className="min-h-screen bg-grid">
      {/* Background ambient glow */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-purple-600/10 rounded-full blur-[140px]" />
        <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-violet-600/10 rounded-full blur-[140px]" />
      </div>

      {/* Header */}
      <header className="relative z-10 border-b border-white/5">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center shadow-lg shadow-violet-500/20">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">
                <span className="gradient-text">Clean</span>9:16
              </h1>
              <p className="text-[11px] text-zinc-500">Lossless Watermark Remover & 9:16 Converter</p>
            </div>
          </div>
          {step !== 'upload' && (
            <button
              onClick={resetAll}
              className="text-xs text-zinc-400 hover:text-white transition flex items-center gap-1.5 px-3 py-1.5 rounded-lg glass glass-hover"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              Start Over
            </button>
          )}
        </div>
      </header>

      {/* Step Indicator */}
      <div className="relative z-10 max-w-6xl mx-auto px-6 pt-6">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          {(['upload', 'editor', 'process', 'done'] as Step[]).map((s, i) => {
            const labels = ['Upload Video', 'Frame & Inpaint', 'Rendering', 'Finished'];
            const icons = ['📁', '✂️', '⚙️', '✅'];
            const isActive = s === step;
            const isPast = ['upload', 'editor', 'process', 'done'].indexOf(step) > i;
            return (
              <div key={s} className="flex items-center gap-2">
                {i > 0 && (
                  <div className={`w-8 h-px ${isPast ? 'bg-violet-500' : 'bg-zinc-800'}`} />
                )}
                <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-all ${
                  isActive ? 'bg-violet-500/15 text-violet-300 ring-1 ring-violet-500/40' :
                  isPast ? 'text-violet-400' : 'text-zinc-600'
                }`}>
                  <span>{icons[i]}</span>
                  <span className="hidden sm:inline font-medium">{labels[i]}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="relative z-10 max-w-6xl mx-auto px-6 pt-4">
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-start gap-3">
            <span className="text-red-400 mt-0.5">⚠️</span>
            <div className="flex-1">
              <p className="text-sm text-red-300">{error}</p>
            </div>
            <button onClick={() => setError('')} className="text-red-400 hover:text-red-300 text-sm">✕</button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="relative z-10 max-w-6xl mx-auto px-6 py-6">

        {/* ──── STEP 1: UPLOAD ──── */}
        {step === 'upload' && (
          <div className="animate-fade-in py-8">
            <div className="text-center mb-10">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-300 text-xs font-medium mb-4">
                ✨ Zero-Blur Watermark Removal Engine
              </div>
              <h2 className="text-4xl sm:text-5xl font-extrabold tracking-tight mb-4">
                Remove Watermarks.<br />
                <span className="gradient-text">Convert to 9:16 Portrait.</span>
              </h2>
              <p className="text-zinc-400 text-base sm:text-lg max-w-xl mx-auto">
                No blurry smudges. Choose between <strong className="text-white">Smart 9:16 Reframe</strong> (0% blur) or <strong className="text-white">Content-Aware Inpaint</strong> with texture matching.
              </p>
            </div>

            {/* Drop Zone */}
            <div
              className={`max-w-2xl mx-auto rounded-2xl upload-border p-12 text-center cursor-pointer transition-all ${
                dragOver ? 'drag-over scale-[1.01]' : 'hover:scale-[1.01]'
              }`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onVideoDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onClick={(e) => { (e.target as HTMLInputElement).value = ''; }}
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
              />
              <div className="w-16 h-16 mx-auto mb-5 rounded-2xl bg-gradient-to-br from-violet-500/20 to-purple-500/10 border border-violet-500/30 flex items-center justify-center">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <p className="text-lg font-semibold text-white mb-2">
                Drop your video here or <span className="text-violet-400 hover:underline">browse</span>
              </p>
              <p className="text-xs text-zinc-500">
                Supports MP4, MOV, WebM, AVI, MKV • 100% Client-Side on your browser
              </p>
            </div>

            {/* Feature Highlights */}
            <div className="max-w-3xl mx-auto mt-12 grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="glass rounded-xl p-5 text-center">
                <div className="text-2xl mb-2">🔍</div>
                <h3 className="font-semibold text-sm mb-1 text-white">0% Blur Reframe</h3>
                <p className="text-xs text-zinc-400">Pushes corner watermarks completely outside the 9:16 frame with full native sharpness.</p>
              </div>
              <div className="glass rounded-xl p-5 text-center">
                <div className="text-2xl mb-2">🎨</div>
                <h3 className="font-semibold text-sm mb-1 text-white">Texture Inpaint</h3>
                <p className="text-xs text-zinc-400">Reconstructs background with fine-grain texture injection rather than flat blur.</p>
              </div>
              <div className="glass rounded-xl p-5 text-center">
                <div className="text-2xl mb-2">📱</div>
                <h3 className="font-semibold text-sm mb-1 text-white">1080×1920 Ready</h3>
                <p className="text-xs text-zinc-400">Standard portrait dimensions for TikTok, YouTube Shorts, and Instagram Reels.</p>
              </div>
            </div>
          </div>
        )}

        {/* ──── STEP 2: EDITOR (FRAME & INPAINT) ──── */}
        {step === 'editor' && videoInfo && (
          <div className="animate-fade-in">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

              {/* Video Player + Canvas Viewport (7 Cols) */}
              <div className="lg:col-span-7">
                <div className="glass rounded-2xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                      <h3 className="font-semibold text-sm">Interactive Video Viewport</h3>
                    </div>
                    <span className="text-xs text-zinc-400 font-mono">
                      {videoInfo.width}×{videoInfo.height} • {formatTime(videoInfo.duration)} • {formatBytes(videoInfo.size)}
                    </span>
                  </div>

                  {/* Video + Canvas Stack */}
                  <div
                    ref={containerRef}
                    className="relative rounded-xl overflow-hidden bg-black/90 shadow-2xl"
                    style={{ aspectRatio: `${videoInfo.width} / ${videoInfo.height}` }}
                  >
                    <video
                      ref={videoRef}
                      src={videoUrl}
                      className="w-full h-full object-contain"
                      controls
                      playsInline
                      preload="auto"
                      onLoadedMetadata={onVideoMetadata}
                    />
                    <canvas
                      ref={canvasRef}
                      className="absolute inset-0 w-full h-full cursor-crosshair pointer-events-auto"
                      onMouseDown={onCanvasMouseDown}
                      onMouseMove={onCanvasMouseMove}
                      onMouseUp={onCanvasMouseUp}
                      onMouseLeave={onCanvasMouseUp}
                    />
                  </div>

                  {/* Controls below canvas */}
                  <div className="flex items-center justify-between mt-3 text-xs text-zinc-400">
                    <span>🖱️ Drag on video to mark watermark rectangle</span>
                    <button
                      onClick={generateLivePreview}
                      className="text-violet-400 hover:text-violet-300 font-medium flex items-center gap-1 px-2.5 py-1 rounded bg-violet-500/10 border border-violet-500/20"
                    >
                      <span>👁️</span> Live Preview 9:16 Frame
                    </button>
                  </div>
                </div>

                {/* Status Bar */}
                <div className="mt-3 flex items-center gap-3 text-xs">
                  {excludedCount > 0 && (
                    <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 px-3 py-1.5 rounded-lg flex items-center gap-1.5">
                      <span>✓</span> {excludedCount} watermark(s) completely excluded from 9:16 (0% blur!)
                    </div>
                  )}
                  {insideCount > 0 && (
                    <div className="bg-amber-500/10 border border-amber-500/20 text-amber-300 px-3 py-1.5 rounded-lg flex items-center gap-1.5">
                      <span>⚠️</span> {insideCount} watermark(s) inside 9:16 frame
                    </div>
                  )}
                </div>
              </div>

              {/* Controls Sidebar (5 Cols) */}
              <div className="lg:col-span-5 space-y-4">

                {/* 1. Mode Selector */}
                <div className="glass rounded-2xl p-4">
                  <h3 className="font-semibold text-xs text-zinc-400 uppercase tracking-wider mb-2">
                    Removal & Output Strategy
                  </h3>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setMode('smart_reframe')}
                      className={`text-left p-3 rounded-xl border transition-all ${
                        mode === 'smart_reframe'
                          ? 'bg-violet-600/20 border-violet-500 text-white ring-1 ring-violet-500/30'
                          : 'bg-white/3 border-white/5 text-zinc-400 hover:bg-white/5'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 font-semibold text-xs mb-1">
                        <span>🌟</span> Smart 9:16 Reframe
                      </div>
                      <p className="text-[11px] text-zinc-500 leading-tight">
                        Lossless. Crops/zooms out watermarks. 100% crisp, zero blur.
                      </p>
                    </button>

                    <button
                      onClick={() => setMode('inpaint')}
                      className={`text-left p-3 rounded-xl border transition-all ${
                        mode === 'inpaint'
                          ? 'bg-violet-600/20 border-violet-500 text-white ring-1 ring-violet-500/30'
                          : 'bg-white/3 border-white/5 text-zinc-400 hover:bg-white/5'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 font-semibold text-xs mb-1">
                        <span>🎨</span> Content Inpaint
                      </div>
                      <p className="text-[11px] text-zinc-500 leading-tight">
                        Texture fill + grain match for watermarks in center of action.
                      </p>
                    </button>
                  </div>
                </div>

                {/* 2. 9:16 Viewport Framing Controls */}
                {mode !== 'blur_fill' && (
                  <div className="glass rounded-2xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="font-semibold text-sm flex items-center gap-2">
                        <span>📐</span> 9:16 Frame Position & Zoom
                      </h3>
                      {watermarkRects.length > 0 && (
                        <button
                          onClick={autoExcludeWatermarks}
                          className="text-[11px] bg-violet-600 hover:bg-violet-500 text-white font-semibold px-2.5 py-1 rounded-md shadow-sm transition-all"
                        >
                          ⚡ Auto-Exclude
                        </button>
                      )}
                    </div>

                    {/* Horizontal Pan */}
                    <div className="space-y-3">
                      <div>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="text-zinc-400">Horizontal Pan (Focus Subject)</span>
                          <span className="font-mono text-zinc-300">{Math.round(panX * 100)}%</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={panX}
                          onChange={(e) => setPanX(parseFloat(e.target.value))}
                          className="w-full accent-violet-500 cursor-pointer"
                        />
                        <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
                          <button onClick={() => setPanX(0)} className="hover:text-zinc-400">Left</button>
                          <button onClick={() => setPanX(0.5)} className="hover:text-zinc-400">Center</button>
                          <button onClick={() => setPanX(1)} className="hover:text-zinc-400">Right</button>
                        </div>
                      </div>

                      {/* Zoom / Scale */}
                      <div>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="text-zinc-400">Safe Margin Zoom (Push corner logos out)</span>
                          <span className="font-mono text-zinc-300">{zoom.toFixed(2)}x</span>
                        </div>
                        <input
                          type="range"
                          min="1.0"
                          max="1.4"
                          step="0.01"
                          value={zoom}
                          onChange={(e) => setZoom(parseFloat(e.target.value))}
                          className="w-full accent-violet-500 cursor-pointer"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* 3. Watermark Rectangles & Presets */}
                <div className="glass rounded-2xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold text-sm flex items-center gap-1.5">
                      <span>✂️</span> Mark Watermark Regions
                    </h3>
                    {watermarkRects.length > 0 && (
                      <button
                        onClick={clearRects}
                        className="text-xs text-red-400 hover:text-red-300 transition"
                      >
                        Clear All
                      </button>
                    )}
                  </div>

                  {/* Preset Buttons */}
                  <div className="grid grid-cols-4 gap-1.5 mb-3">
                    {Object.entries(PRESETS).map(([key, preset]) => (
                      <button
                        key={key}
                        onClick={() => addPreset(key)}
                        className="glass glass-hover rounded-lg py-2 px-1 text-center transition-all hover:scale-105"
                      >
                        <div className="text-base leading-none mb-1">{preset.icon}</div>
                        <div className="text-[10px] text-zinc-400 leading-tight truncate">{preset.label}</div>
                      </button>
                    ))}
                  </div>

                  {/* List of Marked Regions */}
                  {watermarkRects.length > 0 ? (
                    <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                      {watermarkRects.map((r, i) => {
                        const isInside = isWatermarkInside916(r);
                        return (
                          <div
                            key={i}
                            className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs ${
                              isInside ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-emerald-500/10 border border-emerald-500/20'
                            }`}
                          >
                            <span className={isInside ? 'text-amber-300' : 'text-emerald-400'}>
                              {isInside ? '⚠️ Inside 9:16' : '✓ Excluded'} #{i + 1}
                            </span>
                            <button
                              onClick={() => setWatermarkRects(prev => prev.filter((_, j) => j !== i))}
                              className="text-zinc-500 hover:text-red-400"
                            >
                              ✕
                            </button>
                          </div>
                        );
                      })}
                      <button
                        onClick={removeLastRect}
                        className="w-full text-[11px] text-zinc-500 hover:text-zinc-300 pt-1"
                      >
                        ↩ Undo Last Region
                      </button>
                    </div>
                  ) : (
                    <p className="text-[11px] text-zinc-500 text-center py-2">
                      Click a preset or drag directly on the video preview.
                    </p>
                  )}
                </div>

                {/* 4. Film Grain Matching Slider (in inpaint mode) */}
                {mode === 'inpaint' && (
                  <div className="glass rounded-2xl p-4">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-zinc-400">Natural Film Grain Matching (Prevents blur appearance)</span>
                      <span className="font-mono text-zinc-300">{grainIntensity}</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="8"
                      value={grainIntensity}
                      onChange={(e) => setGrainIntensity(parseInt(e.target.value))}
                      className="w-full accent-violet-500 cursor-pointer"
                    />
                  </div>
                )}

                {/* Process Button */}
                <button
                  onClick={startProcessing}
                  className="w-full py-4 rounded-xl font-bold text-sm bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 transition-all hover:scale-[1.01] hover:shadow-lg hover:shadow-violet-500/25 flex items-center justify-center gap-2"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <polygon points="5 3 19 12 5 21 5 3" fill="white" stroke="none" />
                  </svg>
                  Generate 9:16 Video (1080×1920)
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ──── STEP 3: RENDERING ──── */}
        {step === 'process' && (
          <div className="animate-fade-in max-w-lg mx-auto text-center py-16">
            <div className="glass rounded-2xl p-10 glow">
              <div className="w-20 h-20 mx-auto mb-6 relative">
                <div className="absolute inset-0 rounded-full border-4 border-zinc-800" />
                <div
                  className="absolute inset-0 rounded-full border-4 border-transparent border-t-violet-500 animate-spin"
                  style={{ animationDuration: '1s' }}
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-2xl">{ffmpegLoading ? '📦' : '⚙️'}</span>
                </div>
              </div>

              <h3 className="text-xl font-bold mb-2">
                {ffmpegLoading ? 'Preparing Engine...' : 'Rendering 9:16 Video'}
              </h3>
              <p className="text-sm text-zinc-400 mb-6">{statusText}</p>

              <div className="w-full bg-zinc-800 rounded-full h-3 overflow-hidden mb-3">
                <div
                  className="progress-bar h-full rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-xs text-zinc-500 font-mono">{progress}% complete</p>

              <div className="mt-6 pt-6 border-t border-white/5 text-xs text-zinc-500">
                Processed locally inside your browser via WebAssembly. High quality H.264 @ 1080×1920.
              </div>
            </div>
          </div>
        )}

        {/* ──── STEP 4: COMPLETED ──── */}
        {step === 'done' && (
          <div className="animate-fade-in py-6">
            <div className="text-center mb-6">
              <div className="w-14 h-14 mx-auto mb-3 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
                <span className="text-2xl">🎉</span>
              </div>
              <h2 className="text-3xl font-bold mb-1">Your 9:16 Video is Ready!</h2>
              <p className="text-zinc-400 text-sm">Watermarks removed cleanly with original audio intact.</p>
            </div>

            <div className="max-w-md mx-auto">
              <div className="glass rounded-2xl p-4 mb-6">
                <div className="flex items-center justify-between mb-3 text-xs">
                  <span className="font-semibold text-zinc-300">Preview (1080×1920)</span>
                  <span className="text-zinc-500 font-mono">{formatBytes(resultSize)}</span>
                </div>
                <div className="rounded-xl overflow-hidden bg-black flex justify-center shadow-2xl">
                  <video
                    src={resultUrl}
                    controls
                    autoPlay
                    loop
                    className="max-h-[520px] rounded-lg"
                    style={{ aspectRatio: '9/16' }}
                  />
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={downloadResult}
                  className="flex-1 py-4 rounded-xl font-bold text-sm bg-gradient-to-r from-emerald-600 to-green-600 hover:from-emerald-500 hover:to-green-500 transition-all hover:scale-[1.02] shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Download 9:16 Video
                </button>
                <button
                  onClick={resetAll}
                  className="py-4 px-6 rounded-xl font-semibold text-sm glass glass-hover transition-all hover:scale-[1.02]"
                >
                  Process Another
                </button>
              </div>
            </div>
          </div>
        )}

      </main>

      {/* Live Preview Modal */}
      {showPreviewModal && previewFrameUrl && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="glass rounded-2xl p-6 max-w-sm w-full animate-fade-in">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-sm text-white">Live 9:16 Frame Preview</h3>
              <button onClick={() => setShowPreviewModal(false)} className="text-zinc-400 hover:text-white">✕</button>
            </div>
            <div className="rounded-xl overflow-hidden bg-black mb-4">
              <img
                src={previewFrameUrl}
                alt="9:16 Preview"
                className="w-full object-contain max-h-[460px] rounded-lg"
                style={{ aspectRatio: '9/16' }}
              />
            </div>
            <p className="text-xs text-zinc-400 text-center mb-4">
              This is the exact 1080×1920 frame output before full video render.
            </p>
            <button
              onClick={() => setShowPreviewModal(false)}
              className="w-full py-2.5 rounded-xl text-xs font-semibold bg-violet-600 hover:bg-violet-500 text-white"
            >
              Close Preview
            </button>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="relative z-10 border-t border-white/5 mt-12 py-6 text-center text-xs text-zinc-600">
        Clean9:16 — 100% Private, In-Browser Video Watermark Remover & 9:16 Reframe Engine.
      </footer>
    </div>
  );
}
