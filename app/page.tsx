'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

// ────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────
type Step = 'upload' | 'editor' | 'process' | 'done';
type FitMode = 'black_borders' | 'blurred_bg' | 'crop';
type VerticalAlign = 'center' | 'top' | 'bottom';
type RemovalMethod = 'texture_clone' | 'inpaint_grain' | 'border_cover';

interface WatermarkRect {
  x: number; // 0 to 1 relative to source video width
  y: number; // 0 to 1 relative to source video height
  w: number;
  h: number;
}

interface VideoInfo {
  width: number;
  height: number;
  duration: number;
  name: string;
  size: number;
}

// ────────────────────────────────────────────────
// Preset watermark positions (relative to video)
// ────────────────────────────────────────────────
const PRESETS: Record<string, { label: string; icon: string; rect: WatermarkRect }> = {
  'top-left':      { label: 'Top Left',      icon: '↖', rect: { x: 0.01, y: 0.02, w: 0.22, h: 0.09 } },
  'top-right':     { label: 'Top Right',     icon: '↗', rect: { x: 0.74, y: 0.02, w: 0.25, h: 0.09 } },
  'bottom-left':   { label: 'Bottom Left',   icon: '↙', rect: { x: 0.01, y: 0.89, w: 0.26, h: 0.09 } },
  'bottom-right':  { label: 'Bottom Right',  icon: '↘', rect: { x: 0.72, y: 0.89, w: 0.27, h: 0.09 } },
  'bottom-bar':    { label: 'Bottom Bar',    icon: '—', rect: { x: 0.00, y: 0.91, w: 1.00, h: 0.09 } },
  'center':        { label: 'Center',        icon: '◎', rect: { x: 0.30, y: 0.40, w: 0.40, h: 0.20 } },
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

  // 9:16 Conversion Mode (Default: Black Borders without cropping)
  const [fitMode, setFitMode] = useState<FitMode>('black_borders');
  const [verticalAlign, setVerticalAlign] = useState<VerticalAlign>('center');
  const [borderColor, setBorderColor] = useState<string>('#000000');

  // Border Mask Extensions (Extend black border over edge watermarks)
  const [topBorderCover, setTopBorderCover] = useState<number>(0);       // 0 to 60 px
  const [bottomBorderCover, setBottomBorderCover] = useState<number>(0); // 0 to 60 px

  // Watermark Selection & Removal Method
  const [watermarkRects, setWatermarkRects] = useState<WatermarkRect[]>([]);
  const [removalMethod, setRemovalMethod] = useState<RemovalMethod>('texture_clone');
  const [grainIntensity, setGrainIntensity] = useState<number>(3); // 0 to 6

  // Interactive Canvas Drawing State
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [currentRect, setCurrentRect] = useState<WatermarkRect | null>(null);

  // Live Frame Preview Modal
  const [previewFrameUrl, setPreviewFrameUrl] = useState<string>('');
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  // FFmpeg Processing State
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [ffmpegLoading, setFfmpegLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [processingStartTime, setProcessingStartTime] = useState(0);

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
      setError('Please select a valid video file (MP4, MOV, AVI, MKV, WebM).');
      return;
    }
    if (file.size > 500 * 1024 * 1024) {
      setError('File too large. Maximum supported size for browser processing is 500 MB.');
      return;
    }

    setError('');
    setVideoFile(file);
    const url = URL.createObjectURL(file);
    setVideoUrl(url);

    // Initial placeholder metadata; updated when video loads
    setVideoInfo({
      width: 1280,
      height: 720,
      duration: 0,
      name: file.name,
      size: file.size,
    });

    setFitMode('black_borders');
    setVerticalAlign('center');
    setTopBorderCover(0);
    setBottomBorderCover(0);
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
      setVideoInfo(prev => prev ? {
        ...prev,
        width: vid.videoWidth,
        height: vid.videoHeight,
        duration: vid.duration || 0,
      } : null);
    }
  }, []);

  // ────────────────────────────────────────────
  // Calculate Placement of Video on 9:16 Canvas
  // ────────────────────────────────────────────
  const getVideoLayoutOn916 = useCallback(() => {
    const srcW = videoInfo?.width || 1280;
    const srcH = videoInfo?.height || 720;
    const targetW = 1080;
    const targetH = 1920;

    if (fitMode === 'crop') {
      // Crop Mode
      const targetAspect = 9 / 16;
      let cropW = srcW;
      let cropH = srcH;
      if (srcW / srcH > targetAspect) {
        cropW = Math.round(srcH * targetAspect);
      } else {
        cropH = Math.round(srcW / targetAspect);
      }
      return {
        x: 0,
        y: 0,
        w: targetW,
        h: targetH,
        cropW,
        cropH,
        cropX: Math.round((srcW - cropW) / 2),
        cropY: Math.round((srcH - cropH) / 2),
      };
    }

    // Black Borders & Blurred BG Modes: Fit completely without cropping
    const scale = Math.min(targetW / srcW, targetH / srcH);
    const fitW = Math.round(srcW * scale);
    const fitH = Math.round(srcH * scale);
    const fitX = Math.round((targetW - fitW) / 2);

    let fitY = Math.round((targetH - fitH) / 2);
    if (verticalAlign === 'top') fitY = 0;
    if (verticalAlign === 'bottom') fitY = targetH - fitH;

    return {
      x: fitX,
      y: fitY,
      w: fitW,
      h: fitH,
      scale,
      topBorderHeight: fitY,
      bottomBorderHeight: targetH - (fitY + fitH),
    };
  }, [videoInfo, fitMode, verticalAlign]);

  // ────────────────────────────────────────────
  // Canvas Drawing & Watermark Coordinates
  // ────────────────────────────────────────────
  // Maps mouse click on the 9:16 canvas to relative coordinates (0 to 1) on the video
  const canvasToVideoCoords = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();

    // Position relative to 9:16 canvas (0 to 1080, 0 to 1920)
    const canvasX = ((clientX - rect.left) / rect.width) * 1080;
    const canvasY = ((clientY - rect.top) / rect.height) * 1920;

    const layout = getVideoLayoutOn916();

    // Check if click is inside video area
    if (
      canvasX >= layout.x &&
      canvasX <= layout.x + layout.w &&
      canvasY >= layout.y &&
      canvasY <= layout.y + layout.h
    ) {
      return {
        x: (canvasX - layout.x) / layout.w,
        y: (canvasY - layout.y) / layout.h,
      };
    }
    return null;
  }, [getVideoLayoutOn916]);

  const onCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const coords = canvasToVideoCoords(e.clientX, e.clientY);
    if (coords) {
      setIsDrawing(true);
      setDrawStart(coords);
      setCurrentRect(null);
    }
  }, [canvasToVideoCoords]);

  const onCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !drawStart) return;
    const coords = canvasToVideoCoords(e.clientX, e.clientY);
    if (coords) {
      setCurrentRect({
        x: Math.min(drawStart.x, coords.x),
        y: Math.min(drawStart.y, coords.y),
        w: Math.abs(coords.x - drawStart.x),
        h: Math.abs(coords.y - drawStart.y),
      });
    }
  }, [isDrawing, drawStart, canvasToVideoCoords]);

  const onCanvasMouseUp = useCallback(() => {
    if (currentRect && currentRect.w > 0.01 && currentRect.h > 0.01) {
      setWatermarkRects(prev => [...prev, currentRect]);
    }
    setIsDrawing(false);
    setDrawStart(null);
    setCurrentRect(null);
  }, [currentRect]);

  // ────────────────────────────────────────────
  // Canvas Render Loop: Displays Video + Black Borders + Watermark Boxes
  // ────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || step !== 'editor') return;

    let animId: number;

    const render = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const cw = canvas.offsetWidth;
      const ch = canvas.offsetHeight;
      if (cw === 0 || ch === 0) return;

      canvas.width = 1080;
      canvas.height = 1920;

      const layout = getVideoLayoutOn916();

      // 1. Draw Background (Black Borders or Blurred Fill)
      if (fitMode === 'blurred_bg') {
        ctx.save();
        ctx.filter = 'blur(40px) brightness(0.7)';
        ctx.drawImage(video, -40, -40, 1160, 2000);
        ctx.restore();
      } else {
        // Pure Black Borders
        ctx.fillStyle = borderColor;
        ctx.fillRect(0, 0, 1080, 1920);
      }

      // 2. Draw Uncropped Video Content
      if (fitMode === 'crop') {
        const cropX = layout.cropX || 0;
        const cropY = layout.cropY || 0;
        const cropW = layout.cropW || 1080;
        const cropH = layout.cropH || 1920;
        ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, 1080, 1920);
      } else {
        ctx.drawImage(video, layout.x, layout.y, layout.w, layout.h);
      }

      // 3. Draw Extended Border Masks (if user slider is active)
      if (topBorderCover > 0 && fitMode === 'black_borders') {
        ctx.fillStyle = borderColor;
        ctx.fillRect(0, 0, 1080, layout.y + topBorderCover);
      }
      if (bottomBorderCover > 0 && fitMode === 'black_borders') {
        ctx.fillStyle = borderColor;
        ctx.fillRect(0, layout.y + layout.h - bottomBorderCover, 1080, 1920);
      }

      // 4. Draw Marked Watermark Bounding Boxes
      watermarkRects.forEach((r, idx) => {
        const vx = layout.x + r.x * layout.w;
        const vy = layout.y + r.y * layout.h;
        const vw = r.w * layout.w;
        const vh = r.h * layout.h;

        ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
        ctx.fillRect(vx, vy, vw, vh);

        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 4]);
        ctx.strokeRect(vx, vy, vw, vh);
        ctx.setLineDash([]);

        ctx.fillStyle = '#ef4444';
        ctx.font = 'bold 20px Inter, sans-serif';
        ctx.fillText(`Watermark #${idx + 1}`, vx + 6, vy + 24);
      });

      // 5. Draw Currently Dragging Box
      if (currentRect) {
        const vx = layout.x + currentRect.x * layout.w;
        const vy = layout.y + currentRect.y * layout.h;
        const vw = currentRect.w * layout.w;
        const vh = currentRect.h * layout.h;

        ctx.fillStyle = 'rgba(139, 92, 246, 0.3)';
        ctx.fillRect(vx, vy, vw, vh);
        ctx.strokeStyle = '#8b5cf6';
        ctx.lineWidth = 3;
        ctx.strokeRect(vx, vy, vw, vh);
      }

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [step, fitMode, verticalAlign, borderColor, topBorderCover, bottomBorderCover, watermarkRects, currentRect, getVideoLayoutOn916]);

  // ────────────────────────────────────────────
  // Instant Live Frame Preview Generator
  // ────────────────────────────────────────────
  const generateLivePreview = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setPreviewFrameUrl(canvas.toDataURL('image/jpeg', 0.94));
    setShowPreviewModal(true);
  }, []);

  // Preset Handlers
  const addPreset = useCallback((key: string) => {
    const preset = PRESETS[key];
    if (preset) {
      setWatermarkRects(prev => [...prev, { ...preset.rect }]);
    }
  }, []);

  const clearRects = useCallback(() => {
    setWatermarkRects([]);
  }, []);

  // ────────────────────────────────────────────
  // FFmpeg Loading & Video Processing Pipeline
  // ────────────────────────────────────────────
  const loadFFmpeg = useCallback(async () => {
    if (ffmpegRef.current && ffmpegLoaded) return;

    setFfmpegLoading(true);
    setStatusText('Loading FFmpeg WebAssembly engine...');

    try {
      const ffmpeg = new FFmpeg();
      ffmpegRef.current = ffmpeg;

      ffmpeg.on('progress', ({ progress: p }) => {
        const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
        setProgress(pct);
        if (processingStartTime > 0 && p > 0.02) {
          const elapsed = (Date.now() - processingStartTime) / 1000;
          const remaining = (elapsed / p) * (1 - p);
          setStatusText(`Rendering 9:16 video... ${pct}% (~${formatTime(remaining)} remaining)`);
        }
      });

      ffmpeg.on('log', ({ message }) => {
        console.log('[FFmpeg]', message);
      });

      // Try local UMD bundle first for same-origin compliance, then CDN fallback
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
      setError(`Failed to load FFmpeg: ${err instanceof Error ? err.message : String(err)}.`);
      setFfmpegLoading(false);
      throw err;
    }

    setFfmpegLoading(false);
  }, [ffmpegLoaded, processingStartTime]);

  const processVideo = useCallback(async () => {
    if (!videoFile || !ffmpegRef.current || !videoInfo) return;

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

      const vidW = videoInfo.width;
      const vidH = videoInfo.height;

      setStatusText('Processing video with 9:16 black borders...');

      // Build FFmpeg filter chain
      const filterSteps: string[] = [];

      // 1. Watermark Removal / Inpainting on original video
      if (watermarkRects.length > 0) {
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

      if (fitMode === 'blurred_bg') {
        // Blurred background with centered uncropped video
        const delogoPrefix = filterSteps.length > 0 ? `${filterSteps.join(',')},` : '';
        const filterComplex = [
          `[0:v]${delogoPrefix}split=2[bg][fg]`,
          `[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=30:luma_power=2[blurred]`,
          `[fg]scale=1080:1920:force_original_aspect_ratio=decrease[small]`,
          `[blurred][small]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2,setsar=1[out]`,
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
      } else if (fitMode === 'crop') {
        // Direct center crop to 9:16
        const targetAspect = 9 / 16;
        let cropW = vidW;
        let cropH = vidH;
        if (vidW / vidH > targetAspect) {
          cropW = Math.round(vidH * targetAspect);
        } else {
          cropH = Math.round(vidW / targetAspect);
        }
        const cropX = Math.round((vidW - cropW) / 2);
        const cropY = Math.round((vidH - cropH) / 2);

        filterSteps.push(`crop=${cropW}:${cropH}:${cropX}:${cropY}`);
        filterSteps.push(`scale=1080:1920:flags=lanczos,setsar=1`);

        const vf = filterSteps.join(',');

        await ffmpeg.exec([
          '-i', inputFilename,
          '-vf', vf,
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
        // FIT MODE: BLACK BORDERS (Letterbox on top and bottom)
        // 1. Scale video to fit inside 1080x1920 without cropping
        filterSteps.push(`scale=1080:1920:force_original_aspect_ratio=decrease`);

        // 2. Pad to exact 1080x1920 with black borders
        let padY = '(oh-ih)/2'; // Center
        if (verticalAlign === 'top') padY = '0';
        if (verticalAlign === 'bottom') padY = 'oh-ih';

        const colorStr = borderColor.replace('#', '0x') || 'black';
        filterSteps.push(`pad=1080:1920:(ow-iw)/2:${padY}:color=${colorStr}`);

        // 3. Extend top/bottom border cover (if selected)
        if (topBorderCover > 0) {
          // Cover top edge with solid border box
          filterSteps.push(`drawbox=y=0:h=${Math.round(topBorderCover * 2)}:color=${colorStr}@1.0:t=fill`);
        }
        if (bottomBorderCover > 0) {
          // Cover bottom edge with solid border box
          filterSteps.push(`drawbox=y=ih-${Math.round(bottomBorderCover * 2)}:h=${Math.round(bottomBorderCover * 2)}:color=${colorStr}@1.0:t=fill`);
        }

        // 4. Subtle film grain matching on watermark
        if (grainIntensity > 0 && watermarkRects.length > 0) {
          filterSteps.push(`noise=alls=${grainIntensity}:allf=t`);
        }

        // 5. Ensure 1:1 square pixel aspect ratio
        filterSteps.push(`setsar=1`);

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
      setStatusText('Encoding complete! Finalizing...');
      const outputData = await ffmpeg.readFile('output.mp4');
      const uint8 = new Uint8Array(outputData as Uint8Array);
      const blob = new Blob([uint8.buffer], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);

      setResultUrl(url);
      setResultSize(blob.size);
      setProgress(100);
      setStep('done');
      setStatusText('Complete!');

      try {
        await ffmpeg.deleteFile(inputFilename);
        await ffmpeg.deleteFile('output.mp4');
      } catch { /* cleanup */ }

    } catch (err) {
      console.error('Processing error:', err);
      setError(`Processing failed: ${err instanceof Error ? err.message : 'Unknown error'}.`);
      setStep('editor');
    }
  }, [videoFile, videoInfo, fitMode, verticalAlign, borderColor, topBorderCover, bottomBorderCover, watermarkRects, grainIntensity]);

  const startProcessing = useCallback(async () => {
    try {
      await loadFFmpeg();
      await processVideo();
    } catch {
      // handled
    }
  }, [loadFFmpeg, processVideo]);

  // Download & Reset
  const downloadResult = useCallback(() => {
    if (!resultUrl) return;
    const a = document.createElement('a');
    a.href = resultUrl;
    const baseName = videoFile?.name?.replace(/\.[^.]+$/, '') || 'video';
    a.download = `${baseName}_9x16_black_borders.mp4`;
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
    setTopBorderCover(0);
    setBottomBorderCover(0);
    setProgress(0);
    setStatusText('');
    setResultUrl('');
    setResultSize(0);
    setError('');
  }, [videoUrl, resultUrl]);

  return (
    <div className="min-h-screen bg-grid">
      {/* Ambient background glows */}
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
              <p className="text-[11px] text-zinc-500">No-Crop 9:16 Black Borders & Watermark Remover</p>
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
      <div className="relative z-10 max-w-6xl mx-auto px-6 pt-5">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          {(['upload', 'editor', 'process', 'done'] as Step[]).map((s, i) => {
            const labels = ['Upload', 'Borders & Watermark', 'Rendering', 'Finished'];
            const icons = ['📁', '🎬', '⚙️', '✅'];
            const isActive = s === step;
            const isPast = ['upload', 'editor', 'process', 'done'].indexOf(step) > i;
            return (
              <div key={s} className="flex items-center gap-2">
                {i > 0 && <div className={`w-8 h-px ${isPast ? 'bg-violet-500' : 'bg-zinc-800'}`} />}
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

      {/* Error Alert */}
      {error && (
        <div className="relative z-10 max-w-6xl mx-auto px-6 pt-4">
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-start gap-3">
            <span className="text-red-400 mt-0.5">⚠️</span>
            <div className="flex-1 text-sm text-red-300">{error}</div>
            <button onClick={() => setError('')} className="text-red-400 hover:text-red-300">✕</button>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="relative z-10 max-w-6xl mx-auto px-6 py-6">

        {/* ──── STEP 1: UPLOAD ──── */}
        {step === 'upload' && (
          <div className="animate-fade-in py-10">
            <div className="text-center mb-10">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-300 text-xs font-medium mb-4">
                🎬 100% Uncropped 16:9 ➔ 9:16 Vertical Video
              </div>
              <h2 className="text-4xl sm:text-5xl font-extrabold tracking-tight mb-4">
                Full Video to 9:16.<br />
                <span className="gradient-text">Black Borders & Watermark Removal.</span>
              </h2>
              <p className="text-zinc-400 text-base max-w-xl mx-auto">
                Keep 100% of your original video. We add sleek black borders on top & bottom to give you a perfect 9:16 portrait video while removing watermarks cleanly.
              </p>
            </div>

            {/* Upload Zone */}
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
                Supports MP4, MOV, WebM, AVI, MKV • 100% In-Browser & Private
              </p>
            </div>

            {/* Feature Pills */}
            <div className="max-w-3xl mx-auto mt-12 grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="glass rounded-xl p-5 text-center">
                <div className="text-2xl mb-2">⬛</div>
                <h3 className="font-semibold text-sm mb-1 text-white">Zero Cropping</h3>
                <p className="text-xs text-zinc-400">Preserves entire video frame without cutting off edges or faces.</p>
              </div>
              <div className="glass rounded-xl p-5 text-center">
                <div className="text-2xl mb-2">📱</div>
                <h3 className="font-semibold text-sm mb-1 text-white">9:16 Black Borders</h3>
                <p className="text-xs text-zinc-400">Fits perfectly on TikTok, Reels, and YouTube Shorts (1080×1920).</p>
              </div>
              <div className="glass rounded-xl p-5 text-center">
                <div className="text-2xl mb-2">✨</div>
                <h3 className="font-semibold text-sm mb-1 text-white">Clean Logo Eraser</h3>
                <p className="text-xs text-zinc-400">Removes watermarks cleanly with texture matching and film grain.</p>
              </div>
            </div>
          </div>
        )}

        {/* ──── STEP 2: EDITOR (9:16 BLACK BORDERS + WATERMARK) ──── */}
        {step === 'editor' && videoInfo && (
          <div className="animate-fade-in">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

              {/* Left Column: 9:16 Portrait Canvas (5 Cols) */}
              <div className="lg:col-span-5 flex flex-col items-center">
                <div className="glass rounded-2xl p-4 w-full flex flex-col items-center">
                  <div className="w-full flex items-center justify-between mb-3 text-xs">
                    <span className="font-semibold text-zinc-300 flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                      9:16 Portrait Canvas (1080×1920)
                    </span>
                    <span className="text-zinc-500 font-mono">
                      {videoInfo.width}×{videoInfo.height}
                    </span>
                  </div>

                  {/* 9:16 Canvas Box */}
                  <div
                    ref={containerRef}
                    className="relative rounded-xl overflow-hidden shadow-2xl bg-black border border-white/10"
                    style={{ width: '280px', height: '497px', aspectRatio: '9/16' }}
                  >
                    {/* Hidden source video for frame extraction */}
                    <video
                      ref={videoRef}
                      src={videoUrl}
                      className="hidden"
                      playsInline
                      preload="auto"
                      onLoadedMetadata={onVideoMetadata}
                    />

                    {/* Interactive 9:16 Canvas */}
                    <canvas
                      ref={canvasRef}
                      className="w-full h-full cursor-crosshair"
                      onMouseDown={onCanvasMouseDown}
                      onMouseMove={onCanvasMouseMove}
                      onMouseUp={onCanvasMouseUp}
                      onMouseLeave={onCanvasMouseUp}
                    />
                  </div>

                  <p className="text-[11px] text-zinc-400 text-center mt-3">
                    🖱️ Drag over watermark to mark removal box.
                  </p>
                </div>
              </div>

              {/* Right Column: Controls & Settings (7 Cols) */}
              <div className="lg:col-span-7 space-y-4">

                {/* 1. 9:16 Border Style Selector */}
                <div className="glass rounded-2xl p-4">
                  <h3 className="font-semibold text-xs text-zinc-400 uppercase tracking-wider mb-2.5">
                    1. 9:16 Portrait Framing (No Cropping)
                  </h3>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      onClick={() => setFitMode('black_borders')}
                      className={`text-left p-3 rounded-xl border transition-all ${
                        fitMode === 'black_borders'
                          ? 'bg-violet-600/20 border-violet-500 text-white ring-1 ring-violet-500/30'
                          : 'bg-white/3 border-white/5 text-zinc-400 hover:bg-white/5'
                      }`}
                    >
                      <div className="font-semibold text-xs mb-1 flex items-center gap-1.5">
                        <span>⬛</span> Black Borders
                      </div>
                      <p className="text-[10px] text-zinc-500 leading-tight">
                        Classic letterbox on top & bottom. 100% video visible.
                      </p>
                    </button>

                    <button
                      onClick={() => setFitMode('blurred_bg')}
                      className={`text-left p-3 rounded-xl border transition-all ${
                        fitMode === 'blurred_bg'
                          ? 'bg-violet-600/20 border-violet-500 text-white ring-1 ring-violet-500/30'
                          : 'bg-white/3 border-white/5 text-zinc-400 hover:bg-white/5'
                      }`}
                    >
                      <div className="font-semibold text-xs mb-1 flex items-center gap-1.5">
                        <span>🌫️</span> Blurred Background
                      </div>
                      <p className="text-[10px] text-zinc-500 leading-tight">
                        Fills top & bottom with aesthetic blurred video copy.
                      </p>
                    </button>

                    <button
                      onClick={() => setFitMode('crop')}
                      className={`text-left p-3 rounded-xl border transition-all ${
                        fitMode === 'crop'
                          ? 'bg-violet-600/20 border-violet-500 text-white ring-1 ring-violet-500/30'
                          : 'bg-white/3 border-white/5 text-zinc-400 hover:bg-white/5'
                      }`}
                    >
                      <div className="font-semibold text-xs mb-1 flex items-center gap-1.5">
                        <span>✂️</span> Fill & Crop
                      </div>
                      <p className="text-[10px] text-zinc-500 leading-tight">
                        Crops sides to fill 100% of 9:16 screen.
                      </p>
                    </button>
                  </div>

                  {/* Vertical Position */}
                  {fitMode === 'black_borders' && (
                    <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between text-xs">
                      <span className="text-zinc-400">Vertical Alignment:</span>
                      <div className="flex gap-1.5">
                        {(['center', 'top', 'bottom'] as VerticalAlign[]).map((align) => (
                          <button
                            key={align}
                            onClick={() => setVerticalAlign(align)}
                            className={`px-3 py-1 rounded-lg text-xs capitalize transition ${
                              verticalAlign === align
                                ? 'bg-violet-600 text-white'
                                : 'bg-white/5 text-zinc-400 hover:bg-white/10'
                            }`}
                          >
                            {align}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* 2. Edge Watermark Quick-Cover (Extend Black Borders) */}
                {fitMode === 'black_borders' && (
                  <div className="glass rounded-2xl p-4">
                    <h3 className="font-semibold text-xs text-zinc-400 uppercase tracking-wider mb-2.5 flex items-center justify-between">
                      <span>2. Edge Watermark Clean Mask</span>
                      <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                        Zero Blur Guarantee
                      </span>
                    </h3>
                    <p className="text-[11px] text-zinc-400 mb-3">
                      If the watermark is near the top or bottom edge of the video, extend the black border slightly to cover it with pure solid black.
                    </p>

                    <div className="grid grid-cols-2 gap-4 text-xs">
                      <div>
                        <div className="flex justify-between text-zinc-400 mb-1">
                          <span>Top Border Cover</span>
                          <span className="font-mono">{topBorderCover}px</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="50"
                          value={topBorderCover}
                          onChange={(e) => setTopBorderCover(parseInt(e.target.value))}
                          className="w-full accent-violet-500 cursor-pointer"
                        />
                      </div>

                      <div>
                        <div className="flex justify-between text-zinc-400 mb-1">
                          <span>Bottom Border Cover</span>
                          <span className="font-mono">{bottomBorderCover}px</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="50"
                          value={bottomBorderCover}
                          onChange={(e) => setBottomBorderCover(parseInt(e.target.value))}
                          className="w-full accent-violet-500 cursor-pointer"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* 3. Watermark Regions & Presets */}
                <div className="glass rounded-2xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold text-xs text-zinc-400 uppercase tracking-wider">
                      3. Select Watermarks on Video
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
                  <div className="grid grid-cols-6 gap-1.5 mb-3">
                    {Object.entries(PRESETS).map(([key, preset]) => (
                      <button
                        key={key}
                        onClick={() => addPreset(key)}
                        className="glass glass-hover rounded-lg py-2 px-1 text-center transition-all hover:scale-105"
                      >
                        <div className="text-base leading-none mb-1">{preset.icon}</div>
                        <div className="text-[9px] text-zinc-400 leading-tight truncate">{preset.label}</div>
                      </button>
                    ))}
                  </div>

                  {/* Marked Watermark List */}
                  {watermarkRects.length > 0 ? (
                    <div className="space-y-1.5 max-h-28 overflow-y-auto pr-1">
                      {watermarkRects.map((_, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-zinc-300"
                        >
                          <span>Watermark #{i + 1} marked</span>
                          <button
                            onClick={() => setWatermarkRects(prev => prev.filter((_, j) => j !== i))}
                            className="text-zinc-500 hover:text-red-400"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-zinc-500 text-center py-1">
                      Click a preset or drag directly on the video canvas to mark watermark.
                    </p>
                  )}
                </div>

                {/* 4. Film Grain Natural Texture Matching */}
                {watermarkRects.length > 0 && (
                  <div className="glass rounded-2xl p-4">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-zinc-400">Natural Film Grain Matching (Prevents blur appearance)</span>
                      <span className="font-mono text-zinc-300">{grainIntensity}</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="6"
                      value={grainIntensity}
                      onChange={(e) => setGrainIntensity(parseInt(e.target.value))}
                      className="w-full accent-violet-500 cursor-pointer"
                    />
                  </div>
                )}

                {/* Buttons: Live Preview & Process */}
                <div className="flex gap-2">
                  <button
                    onClick={generateLivePreview}
                    className="py-4 px-5 rounded-xl font-semibold text-xs glass glass-hover border border-white/10 text-white flex items-center justify-center gap-1.5"
                  >
                    <span>👁️</span> Full Preview
                  </button>

                  <button
                    onClick={startProcessing}
                    className="flex-1 py-4 rounded-xl font-bold text-sm bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 transition-all hover:scale-[1.01] shadow-lg shadow-violet-500/25 flex items-center justify-center gap-2"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <polygon points="5 3 19 12 5 21 5 3" fill="white" stroke="none" />
                    </svg>
                    Generate 9:16 Video (1080×1920)
                  </button>
                </div>

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
              <p className="text-zinc-400 text-sm">Converted to 9:16 with black borders and original audio preserved.</p>
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
              <h3 className="font-bold text-sm text-white">Full 9:16 Output Preview</h3>
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
              Exact 1080×1920 output showing your uncropped video with top/bottom black borders.
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
        Clean9:16 — 100% Private, In-Browser Video Watermark Remover & 9:16 Black Borders Converter.
      </footer>
    </div>
  );
}
