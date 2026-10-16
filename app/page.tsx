'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

// ────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────
type Step = 'upload' | 'select' | 'process' | 'done';

interface WatermarkRect {
  x: number;
  y: number;
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

type CropMode = 'center' | 'blur';

// ────────────────────────────────────────────────
// Preset watermark positions (relative 0-1)
// ────────────────────────────────────────────────
const PRESETS: Record<string, { label: string; icon: string; rect: WatermarkRect }> = {
  'top-left':      { label: 'Top Left',      icon: '↖', rect: { x: 0.01, y: 0.01, w: 0.22, h: 0.08 } },
  'top-center':    { label: 'Top Center',    icon: '↑', rect: { x: 0.30, y: 0.01, w: 0.40, h: 0.07 } },
  'top-right':     { label: 'Top Right',     icon: '↗', rect: { x: 0.75, y: 0.01, w: 0.24, h: 0.08 } },
  'bottom-left':   { label: 'Bottom Left',   icon: '↙', rect: { x: 0.01, y: 0.90, w: 0.28, h: 0.09 } },
  'bottom-center': { label: 'Bottom Center', icon: '↓', rect: { x: 0.25, y: 0.92, w: 0.50, h: 0.07 } },
  'bottom-right':  { label: 'Bottom Right',  icon: '↘', rect: { x: 0.70, y: 0.90, w: 0.29, h: 0.09 } },
  'center':        { label: 'Center',        icon: '◎', rect: { x: 0.30, y: 0.38, w: 0.40, h: 0.24 } },
};

// ────────────────────────────────────────────────
// Helper: format bytes
// ────────────────────────────────────────────────
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
// MAIN PAGE COMPONENT
// ════════════════════════════════════════════════
export default function Home() {
  // Step state
  const [step, setStep] = useState<Step>('upload');

  // Upload state
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>('');
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Watermark selection state
  const [watermarkRects, setWatermarkRects] = useState<WatermarkRect[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [currentRect, setCurrentRect] = useState<WatermarkRect | null>(null);
  const [cropMode, setCropMode] = useState<CropMode>('center');

  // Processing state
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [ffmpegLoading, setFfmpegLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [processingStartTime, setProcessingStartTime] = useState(0);

  // Result state
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
  // Upload handlers
  // ────────────────────────────────────────────
  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('video/')) {
      setError('Please upload a video file (MP4, MOV, AVI, MKV, WebM).');
      return;
    }
    if (file.size > 500 * 1024 * 1024) {
      setError('File too large. Please use videos under 500 MB for browser processing.');
      return;
    }

    setError('');
    setVideoFile(file);
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    setVideoInfo({
      width: 0, height: 0, duration: 0,
      name: file.name, size: file.size,
    });
  }, []);

  const onVideoDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onVideoLoad = useCallback(() => {
    const vid = videoRef.current;
    if (!vid) return;
    setVideoInfo(prev => prev ? {
      ...prev,
      width: vid.videoWidth,
      height: vid.videoHeight,
      duration: vid.duration,
    } : null);
    setStep('select');
  }, []);

  // ────────────────────────────────────────────
  // Canvas drawing for watermark selection
  // ────────────────────────────────────────────
  const getCanvasCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas || !videoInfo) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  }, [videoInfo]);

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

  // Draw rectangles on canvas overlay
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video || step !== 'select') return;

    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      canvas.width = canvas.offsetWidth * window.devicePixelRatio;
      canvas.height = canvas.offsetHeight * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
      const cw = canvas.offsetWidth;
      const ch = canvas.offsetHeight;

      ctx.clearRect(0, 0, cw, ch);

      // Draw saved rects
      watermarkRects.forEach((r, i) => {
        const rx = r.x * cw, ry = r.y * ch, rw = r.w * cw, rh = r.h * ch;
        ctx.fillStyle = 'rgba(239, 68, 68, 0.18)';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);
        // Label
        ctx.fillStyle = '#ef4444';
        ctx.font = '12px Inter, sans-serif';
        ctx.fillText(`Region ${i + 1}`, rx + 4, ry + 14);
      });

      // Draw current rect being drawn
      if (currentRect) {
        const rx = currentRect.x * cw, ry = currentRect.y * ch;
        const rw = currentRect.w * cw, rh = currentRect.h * ch;
        ctx.fillStyle = 'rgba(139, 92, 246, 0.2)';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = '#8b5cf6';
        ctx.lineWidth = 2;
        ctx.strokeRect(rx, ry, rw, rh);
      }

      requestAnimationFrame(draw);
    };

    const animId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animId);
  }, [step, watermarkRects, currentRect]);

  // ────────────────────────────────────────────
  // Preset selection
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
  // FFmpeg processing
  // ────────────────────────────────────────────
  const loadFFmpeg = useCallback(async () => {
    if (ffmpegRef.current && ffmpegLoaded) return;

    setFfmpegLoading(true);
    setStatusText('Loading FFmpeg engine...');

    try {
      const ffmpeg = new FFmpeg();
      ffmpegRef.current = ffmpeg;

      ffmpeg.on('progress', ({ progress: p }) => {
        const pct = Math.max(0, Math.min(100, Math.round(p * 100)));
        setProgress(pct);
        if (processingStartTime > 0) {
          const elapsed = (Date.now() - processingStartTime) / 1000;
          if (p > 0.01) {
            const remaining = (elapsed / p) * (1 - p);
            setStatusText(`Processing... ${pct}% — ~${formatTime(remaining)} remaining`);
          }
        }
      });

      ffmpeg.on('log', ({ message }) => {
        console.log('[FFmpeg]', message);
      });

      // Try loading from local public folder first for faster loading & same-origin COEP compliance, fallback to CDN
      try {
        await ffmpeg.load({
          coreURL: await toBlobURL('/ffmpeg/ffmpeg-core.js', 'text/javascript'),
          wasmURL: await toBlobURL('/ffmpeg/ffmpeg-core.wasm', 'application/wasm'),
        });
      } catch (localErr) {
        console.warn('Local FFmpeg load failed, trying unpkg CDN:', localErr);
        const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
        await ffmpeg.load({
          coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
        });
      }

      setFfmpegLoaded(true);
      setStatusText('FFmpeg loaded successfully!');
    } catch (err) {
      console.error('FFmpeg load error:', err);
      setError('Failed to load FFmpeg. Please check your browser supports WebAssembly and try again.');
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
    setStatusText('Preparing video...');

    try {
      // Write input file to FFmpeg virtual filesystem
      const inputData = await fetchFile(videoFile);
      await ffmpeg.writeFile('input.mp4', inputData);

      // Build the FFmpeg filter chain
      const filters: string[] = [];

      // 1) Watermark removal using delogo filter
      if (watermarkRects.length > 0 && videoInfo) {
        watermarkRects.forEach((r) => {
          const px = Math.round(r.x * videoInfo.width);
          const py = Math.round(r.y * videoInfo.height);
          const pw = Math.round(r.w * videoInfo.width);
          const ph = Math.round(r.h * videoInfo.height);
          // Clamp values
          const cx = Math.max(1, px);
          const cy = Math.max(1, py);
          const cw = Math.min(pw, videoInfo.width - cx - 1);
          const ch = Math.min(ph, videoInfo.height - cy - 1);
          if (cw > 2 && ch > 2) {
            filters.push(`delogo=x=${cx}:y=${cy}:w=${cw}:h=${ch}`);
          }
        });
      }

      // 2) 9:16 conversion
      if (videoInfo) {
        const srcW = videoInfo.width;
        const srcH = videoInfo.height;
        const targetRatio = 9 / 16;
        const currentRatio = srcW / srcH;

        if (cropMode === 'center') {
          if (Math.abs(currentRatio - targetRatio) > 0.02) {
            if (currentRatio > targetRatio) {
              // Wider → crop sides
              const newW = Math.round(srcH * targetRatio);
              const offset = Math.round((srcW - newW) / 2);
              filters.push(`crop=${newW}:${srcH}:${offset}:0`);
            } else {
              // Taller → crop top/bottom
              const newH = Math.round(srcW / targetRatio);
              const offset = Math.round((srcH - newH) / 2);
              filters.push(`crop=${srcW}:${newH}:0:${offset}`);
            }
          }
          filters.push('scale=1080:1920');
        } else {
          // blur mode: fit video inside 9:16 with blurred background
          // This requires a complex filter graph, handled separately below
        }
      }

      setStatusText('Processing video...');

      if (cropMode === 'blur' && videoInfo) {
        // Complex filter graph for blur fill
        const delogoChain = filters.filter(f => f.startsWith('delogo')).join(',');
        const delogoPrefix = delogoChain ? `${delogoChain},` : '';

        const filterComplex = [
          `[0:v]${delogoPrefix}split=2[bg][fg]`,
          `[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=25:luma_power=2[blurred]`,
          `[fg]scale=1080:1920:force_original_aspect_ratio=decrease[small]`,
          `[blurred][small]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2[out]`,
        ].join(';');

        await ffmpeg.exec([
          '-i', 'input.mp4',
          '-filter_complex', filterComplex,
          '-map', '[out]',
          '-map', '0:a?',
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-movflags', '+faststart',
          '-y',
          'output.mp4',
        ]);
      } else {
        // Simple filter chain
        const vf = filters.length > 0 ? filters.join(',') : 'scale=1080:1920';

        await ffmpeg.exec([
          '-i', 'input.mp4',
          '-vf', vf,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-movflags', '+faststart',
          '-y',
          'output.mp4',
        ]);
      }

      // Read output
      setStatusText('Finalizing...');
      const outputData = await ffmpeg.readFile('output.mp4');
      const uint8 = new Uint8Array(outputData as Uint8Array);
      const blob = new Blob([uint8.buffer], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);

      setResultUrl(url);
      setResultSize(blob.size);
      setProgress(100);
      setStep('done');
      setStatusText('Done!');

      // Cleanup FFmpeg filesystem
      try {
        await ffmpeg.deleteFile('input.mp4');
        await ffmpeg.deleteFile('output.mp4');
      } catch { /* ignore cleanup errors */ }

    } catch (err) {
      console.error('Processing error:', err);
      setError(`Processing failed: ${err instanceof Error ? err.message : 'Unknown error'}. Try a smaller video or different format.`);
      setStep('select');
    }
  }, [videoFile, videoInfo, watermarkRects, cropMode]);

  const startProcessing = useCallback(async () => {
    try {
      await loadFFmpeg();
      await processVideo();
    } catch {
      // Error already handled
    }
  }, [loadFFmpeg, processVideo]);

  // ────────────────────────────────────────────
  // Download
  // ────────────────────────────────────────────
  const downloadResult = useCallback(() => {
    if (!resultUrl) return;
    const a = document.createElement('a');
    a.href = resultUrl;
    const baseName = videoFile?.name?.replace(/\.[^.]+$/, '') || 'video';
    a.download = `${baseName}_no_watermark_9x16.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [resultUrl, videoFile]);

  // ────────────────────────────────────────────
  // Reset
  // ────────────────────────────────────────────
  const resetAll = useCallback(() => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setStep('upload');
    setVideoFile(null);
    setVideoUrl('');
    setVideoInfo(null);
    setWatermarkRects([]);
    setCurrentRect(null);
    setCropMode('center');
    setProgress(0);
    setStatusText('');
    setResultUrl('');
    setResultSize(0);
    setError('');
  }, [videoUrl, resultUrl]);

  // ════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════
  return (
    <div className="min-h-screen bg-grid">
      {/* Background gradient orbs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 -left-40 w-96 h-96 bg-purple-600/10 rounded-full blur-[120px]" />
        <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-violet-600/10 rounded-full blur-[120px]" />
      </div>

      {/* Header */}
      <header className="relative z-10 border-b border-white/5">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
            </div>
            <h1 className="text-lg font-semibold tracking-tight">
              <span className="gradient-text">Watermark</span> Remover
            </h1>
          </div>
          {step !== 'upload' && (
            <button
              onClick={resetAll}
              className="text-sm text-zinc-400 hover:text-white transition flex items-center gap-1.5"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              Start Over
            </button>
          )}
        </div>
      </header>

      {/* Step indicator */}
      <div className="relative z-10 max-w-6xl mx-auto px-6 pt-6">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          {(['upload', 'select', 'process', 'done'] as Step[]).map((s, i) => {
            const labels = ['Upload', 'Select Area', 'Process', 'Download'];
            const icons = ['📁', '✂️', '⚙️', '✅'];
            const isActive = s === step;
            const isPast = ['upload', 'select', 'process', 'done'].indexOf(step) > i;
            return (
              <div key={s} className="flex items-center gap-2">
                {i > 0 && (
                  <div className={`w-8 h-px ${isPast ? 'bg-violet-500' : 'bg-zinc-800'}`} />
                )}
                <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-all ${
                  isActive ? 'bg-violet-500/15 text-violet-400 ring-1 ring-violet-500/30' :
                  isPast ? 'text-violet-400' : 'text-zinc-600'
                }`}>
                  <span>{icons[i]}</span>
                  <span className="hidden sm:inline">{labels[i]}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="relative z-10 max-w-6xl mx-auto px-6 pt-4">
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 flex items-start gap-3">
            <span className="text-red-400 mt-0.5">⚠️</span>
            <div className="flex-1">
              <p className="text-sm text-red-300">{error}</p>
            </div>
            <button onClick={() => setError('')} className="text-red-400 hover:text-red-300">✕</button>
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="relative z-10 max-w-6xl mx-auto px-6 py-8">

        {/* ──── STEP: UPLOAD ──── */}
        {step === 'upload' && (
          <div className="animate-fade-in">
            {/* Hero */}
            <div className="text-center mb-10">
              <h2 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
                Remove Watermarks.<br />
                <span className="gradient-text">Convert to 9:16.</span>
              </h2>
              <p className="text-zinc-400 text-lg max-w-xl mx-auto">
                100% free. Runs entirely in your browser. No uploads to any server.
                Your videos stay private.
              </p>
            </div>

            {/* Upload zone */}
            <div
              className={`max-w-2xl mx-auto rounded-2xl upload-border p-12 text-center cursor-pointer transition-all ${
                dragOver ? 'drag-over scale-[1.02]' : 'hover:scale-[1.01]'
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
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
              />
              <div className="w-16 h-16 mx-auto mb-5 rounded-2xl bg-violet-500/10 flex items-center justify-center">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <p className="text-lg font-medium text-white mb-2">
                Drop your video here or <span className="text-violet-400">browse</span>
              </p>
              <p className="text-sm text-zinc-500">
                Supports MP4, MOV, AVI, MKV, WebM • Max 500 MB
              </p>
            </div>

            {/* Features */}
            <div className="max-w-3xl mx-auto mt-12 grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { icon: '🛡️', title: 'Private & Secure', desc: 'All processing happens in your browser. Nothing is uploaded.' },
                { icon: '✂️', title: 'Smart Removal', desc: 'FFmpeg delogo filter intelligently fills the watermark area.' },
                { icon: '📱', title: '9:16 Ready', desc: 'Auto-crop or blur-fill to perfect portrait format.' },
              ].map((f) => (
                <div key={f.title} className="glass rounded-xl p-5 text-center">
                  <div className="text-2xl mb-2">{f.icon}</div>
                  <h3 className="font-semibold text-sm mb-1">{f.title}</h3>
                  <p className="text-xs text-zinc-500">{f.desc}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Hidden video for metadata loading */}
        {videoUrl && step === 'upload' && (
          <video
            ref={videoRef}
            src={videoUrl}
            className="hidden"
            onLoadedMetadata={onVideoLoad}
            preload="metadata"
          />
        )}

        {/* ──── STEP: SELECT WATERMARK ──── */}
        {step === 'select' && videoInfo && (
          <div className="animate-fade-in">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Video preview with canvas overlay */}
              <div className="lg:col-span-2">
                <div className="glass rounded-2xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold text-sm flex items-center gap-2">
                      <span className="text-violet-400">▶</span>
                      Video Preview
                    </h3>
                    <span className="text-xs text-zinc-500">
                      {videoInfo.width}×{videoInfo.height} • {formatTime(videoInfo.duration)} • {formatBytes(videoInfo.size)}
                    </span>
                  </div>

                  {/* Video + canvas container */}
                  <div
                    ref={containerRef}
                    className="relative rounded-lg overflow-hidden bg-black"
                    style={{ aspectRatio: `${videoInfo.width} / ${videoInfo.height}` }}
                  >
                    <video
                      ref={videoRef}
                      src={videoUrl}
                      className="w-full h-full object-contain"
                      controls
                      preload="auto"
                    />
                    <canvas
                      ref={canvasRef}
                      className="absolute inset-0 w-full h-full cursor-crosshair"
                      onMouseDown={onCanvasMouseDown}
                      onMouseMove={onCanvasMouseMove}
                      onMouseUp={onCanvasMouseUp}
                      onMouseLeave={onCanvasMouseUp}
                    />
                  </div>

                  <p className="text-xs text-zinc-500 mt-3 text-center">
                    🖱️ Click and drag on the video to select watermark area. You can select multiple regions.
                  </p>
                </div>
              </div>

              {/* Controls panel */}
              <div className="space-y-4">
                {/* Preset positions */}
                <div className="glass rounded-2xl p-4">
                  <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
                    <span className="text-violet-400">📌</span>
                    Quick Select Presets
                  </h3>
                  <div className="grid grid-cols-3 gap-2">
                    {Object.entries(PRESETS).map(([key, preset]) => (
                      <button
                        key={key}
                        onClick={() => addPreset(key)}
                        className="glass glass-hover rounded-lg px-2 py-2.5 text-xs text-center transition-all hover:scale-105"
                      >
                        <div className="text-lg mb-0.5">{preset.icon}</div>
                        <div className="text-zinc-400">{preset.label}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Selected regions */}
                <div className="glass rounded-2xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold text-sm flex items-center gap-2">
                      <span className="text-violet-400">📋</span>
                      Selected Regions ({watermarkRects.length})
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
                  {watermarkRects.length === 0 ? (
                    <p className="text-xs text-zinc-600 text-center py-4">
                      No regions selected yet.<br />Draw on the video or use a preset.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {watermarkRects.map((r, i) => (
                        <div key={i} className="flex items-center justify-between bg-white/5 rounded-lg px-3 py-2 text-xs">
                          <span className="text-zinc-300">
                            Region {i + 1}
                            <span className="text-zinc-600 ml-2">
                              {Math.round(r.x * 100)}%, {Math.round(r.y * 100)}%
                            </span>
                          </span>
                          <button
                            onClick={() => setWatermarkRects(prev => prev.filter((_, j) => j !== i))}
                            className="text-zinc-500 hover:text-red-400 transition"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {watermarkRects.length > 0 && (
                    <button
                      onClick={removeLastRect}
                      className="w-full mt-2 text-xs text-zinc-500 hover:text-zinc-300 transition"
                    >
                      ↩ Undo Last
                    </button>
                  )}
                </div>

                {/* Crop mode */}
                <div className="glass rounded-2xl p-4">
                  <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
                    <span className="text-violet-400">📐</span>
                    9:16 Conversion Mode
                  </h3>
                  <div className="space-y-2">
                    <button
                      onClick={() => setCropMode('center')}
                      className={`w-full text-left rounded-lg px-4 py-3 text-sm transition-all ${
                        cropMode === 'center'
                          ? 'bg-violet-500/15 ring-1 ring-violet-500/40 text-white'
                          : 'bg-white/3 text-zinc-400 hover:bg-white/5'
                      }`}
                    >
                      <div className="font-medium">Center Crop</div>
                      <div className="text-xs text-zinc-500 mt-0.5">
                        Crops sides to fit 9:16. Best for centered content.
                      </div>
                    </button>
                    <button
                      onClick={() => setCropMode('blur')}
                      className={`w-full text-left rounded-lg px-4 py-3 text-sm transition-all ${
                        cropMode === 'blur'
                          ? 'bg-violet-500/15 ring-1 ring-violet-500/40 text-white'
                          : 'bg-white/3 text-zinc-400 hover:bg-white/5'
                      }`}
                    >
                      <div className="font-medium">Blur Fill</div>
                      <div className="text-xs text-zinc-500 mt-0.5">
                        Fits video in 9:16 with blurred background. Keeps all content.
                      </div>
                    </button>
                  </div>
                </div>

                {/* Process button */}
                <button
                  onClick={startProcessing}
                  className="w-full py-4 rounded-xl font-semibold text-sm bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 transition-all hover:scale-[1.02] hover:shadow-lg hover:shadow-violet-500/20 flex items-center justify-center gap-2"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <circle cx="12" cy="12" r="10" />
                    <polygon points="10 8 16 12 10 16 10 8" fill="white" stroke="none" />
                  </svg>
                  Remove Watermark & Convert to 9:16
                </button>

                {watermarkRects.length === 0 && (
                  <p className="text-xs text-center text-zinc-600">
                    Tip: You can skip watermark selection to just convert to 9:16
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ──── STEP: PROCESSING ──── */}
        {step === 'process' && (
          <div className="animate-fade-in max-w-lg mx-auto text-center py-16">
            <div className="glass rounded-2xl p-10 glow">
              {/* Spinning icon */}
              <div className="w-20 h-20 mx-auto mb-6 relative">
                <div className="absolute inset-0 rounded-full border-4 border-zinc-800" />
                <div
                  className="absolute inset-0 rounded-full border-4 border-transparent border-t-violet-500 animate-spin"
                  style={{ animationDuration: '1s' }}
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-2xl">
                    {ffmpegLoading ? '📦' : '⚙️'}
                  </span>
                </div>
              </div>

              <h3 className="text-xl font-semibold mb-2">
                {ffmpegLoading ? 'Loading Engine...' : 'Processing Video'}
              </h3>
              <p className="text-sm text-zinc-400 mb-6">{statusText}</p>

              {/* Progress bar */}
              <div className="w-full bg-zinc-800 rounded-full h-3 overflow-hidden mb-3">
                <div
                  className="progress-bar h-full rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-xs text-zinc-500">{progress}% complete</p>

              {/* Info */}
              <div className="mt-6 pt-6 border-t border-white/5 text-xs text-zinc-600">
                Processing happens in your browser using WebAssembly.
                <br />Do not close this tab.
              </div>
            </div>
          </div>
        )}

        {/* ──── STEP: DONE ──── */}
        {step === 'done' && (
          <div className="animate-fade-in">
            <div className="text-center mb-8">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-emerald-500/15 flex items-center justify-center">
                <span className="text-3xl">✅</span>
              </div>
              <h2 className="text-2xl font-bold mb-2">Processing Complete!</h2>
              <p className="text-zinc-400 text-sm">
                Your video is ready. Watermark removed and converted to 9:16 format.
              </p>
            </div>

            <div className="max-w-2xl mx-auto">
              {/* Result preview */}
              <div className="glass rounded-2xl p-4 mb-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-sm">Preview</h3>
                  <span className="text-xs text-zinc-500">
                    1080×1920 (9:16) • {formatBytes(resultSize)}
                  </span>
                </div>
                <div className="rounded-lg overflow-hidden bg-black max-h-[500px] flex justify-center">
                  <video
                    src={resultUrl}
                    controls
                    className="max-h-[500px] rounded-lg"
                    style={{ aspectRatio: '9/16' }}
                  />
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={downloadResult}
                  className="flex-1 py-4 rounded-xl font-semibold text-sm bg-gradient-to-r from-emerald-600 to-green-600 hover:from-emerald-500 hover:to-green-500 transition-all hover:scale-[1.02] hover:shadow-lg hover:shadow-emerald-500/20 flex items-center justify-center gap-2"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Download Video
                </button>
                <button
                  onClick={resetAll}
                  className="flex-1 py-4 rounded-xl font-semibold text-sm glass glass-hover transition-all hover:scale-[1.02] flex items-center justify-center gap-2"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                  </svg>
                  Process Another Video
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-white/5 mt-16">
        <div className="max-w-6xl mx-auto px-6 py-6 text-center text-xs text-zinc-600">
          <p>
            Video Watermark Remover — All processing happens locally in your browser.
            No data is sent to any server.
          </p>
        </div>
      </footer>
    </div>
  );
}
