import os
import sys
import uuid
import re
import asyncio
import subprocess
import shutil
import tempfile
import time
from pathlib import Path
from typing import Optional, Dict

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import cv2
import numpy as np

# Determine writable directory (Vercel uses /tmp)
BASE_DIR = Path(__file__).resolve().parent
IS_VERCEL = bool(os.environ.get("VERCEL"))

if IS_VERCEL:
    TEMP_BASE = Path(tempfile.gettempdir()) / "gemini_wmr"
else:
    TEMP_BASE = BASE_DIR

UPLOADS_DIR = TEMP_BASE / "uploads"
OUTPUTS_DIR = TEMP_BASE / "outputs"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

ALPHA_MASK_FILE = BASE_DIR / "least_squares_alpha_40.png"

app = FastAPI(title="Gemini Video Watermark Remover Pro")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

jobs: Dict[str, dict] = {}
active_websockets: Dict[str, list[WebSocket]] = {}

def get_ffmpeg_path():
    try:
        import imageio_ffmpeg
        p = imageio_ffmpeg.get_ffmpeg_exe()
        if p and os.path.exists(p):
            return p
    except Exception:
        pass

    ffmpeg = shutil.which('ffmpeg')
    if ffmpeg:
        return ffmpeg
    possible_paths = [
        r'C:\Users\LENOVO\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe',
        r'C:\ffmpeg\bin\ffmpeg.exe',
    ]
    for p in possible_paths:
        if os.path.exists(p):
            return p
    return 'ffmpeg'

HTML_CONTENT = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gemini Video Watermark Remover Pro</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Fira+Code:wght@400;500;600&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    body {
      background: radial-gradient(circle at 50% 0%, #171b30 0%, #0b0f19 50%, #05070e 100%);
      min-height: 100vh;
      color: #f8fafc;
      font-family: 'Plus Jakarta Sans', sans-serif;
    }
    .glass-card {
      background: rgba(17, 24, 39, 0.75);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.7);
    }
    .glass-input {
      background: rgba(30, 41, 59, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    .watermark-box-overlay {
      position: absolute;
      border: 2px dashed #ec4899;
      background: rgba(236, 72, 153, 0.25);
      border-radius: 8px;
      pointer-events: none;
      transition: all 0.15s ease-out;
      box-shadow: 0 0 15px rgba(236, 72, 153, 0.6);
    }
  </style>
</head>
<body class="selection:bg-pink-500 selection:text-white pb-16">

  <!-- Header -->
  <header class="border-b border-white/10 backdrop-blur-md sticky top-0 z-50 bg-[#0b0f19]/80">
    <div class="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-pink-500 via-purple-600 to-blue-500 flex items-center justify-center shadow-lg shadow-pink-500/20">
          <i data-lucide="sparkles" class="w-5 h-5 text-white"></i>
        </div>
        <div>
          <span class="font-bold text-lg tracking-tight bg-gradient-to-r from-white via-slate-100 to-slate-400 bg-clip-text text-transparent">
            Gemini Video Watermark Remover Pro
          </span>
          <span class="ml-2 text-xs font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            9:16 & 16:9 Smart Engine
          </span>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button id="quickTestCurrent" class="text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pink-500/10 hover:bg-pink-500/20 text-pink-300 border border-pink-500/30 transition">
          <i data-lucide="refresh-cw" class="w-3.5 h-3.5 text-pink-400"></i>
          <span>Reload Last Video</span>
        </button>
      </div>
    </div>
  </header>

  <main class="max-w-6xl mx-auto px-4 mt-8">
    <div class="text-center mb-6">
      <h1 class="text-3xl font-extrabold tracking-tight mb-2">
        100% Guaranteed Watermark Removal
      </h1>
      <p class="text-slate-400 text-sm max-w-xl mx-auto">
        Supports both <strong>9:16 Portrait</strong> (Shorts/Reels) and <strong>16:9 Landscape</strong> Gemini & Veo videos with auto-calibrated positioning.
      </p>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
      <!-- Left Controls (5 cols) -->
      <div class="lg:col-span-5 space-y-6">

        <!-- File Select Card -->
        <div class="glass-card rounded-2xl p-6">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-4 flex items-center gap-2">
            <i data-lucide="upload-cloud" class="w-4 h-4 text-pink-500"></i>
            1. Select Video
          </h2>

          <div id="dropZone" class="border-2 border-dashed border-white/15 hover:border-pink-500/60 rounded-xl p-5 text-center cursor-pointer transition-all bg-white/[0.02]">
            <input type="file" id="fileInput" accept="video/mp4,video/quicktime,video/webm" class="hidden">
            <div id="uploadPlaceholder">
              <i data-lucide="film" class="w-8 h-8 text-pink-400/80 mx-auto mb-2"></i>
              <p class="text-xs font-semibold text-slate-200">Click or drop video file</p>
              <p class="text-[11px] text-slate-500">MP4, MOV, WebM (Any aspect ratio)</p>
            </div>
            <div id="fileInfo" class="hidden flex items-center justify-between text-left bg-slate-900/80 p-2.5 rounded-lg border border-white/10">
              <div class="truncate mr-2">
                <p id="fileName" class="text-xs font-semibold text-white truncate"></p>
                <p id="fileMeta" class="text-[10px] font-mono text-slate-400"></p>
              </div>
              <button id="clearFile" class="text-slate-400 hover:text-red-400 p-1">
                <i data-lucide="x" class="w-4 h-4"></i>
              </button>
            </div>
          </div>
        </div>

        <!-- Watermark Target Controls -->
        <div class="glass-card rounded-2xl p-6 space-y-4">
          <div class="flex items-center justify-between">
            <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
              <i data-lucide="crosshair" class="w-4 h-4 text-blue-400"></i>
              2. Watermark Targeting
            </h2>
            <span id="detectedFormatBadge" class="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20">
              Auto: 16:9
            </span>
          </div>

          <!-- Quick Aspect Ratio Presets -->
          <div class="grid grid-cols-2 gap-2 text-xs">
            <button type="button" id="presetPortrait" class="p-2.5 rounded-xl border border-white/10 hover:border-pink-500/50 bg-white/5 hover:bg-pink-500/10 text-left transition flex items-center gap-2">
              <span class="text-lg">📱</span>
              <div>
                <div class="font-bold text-white text-[11px]">9:16 Portrait</div>
                <div class="text-[10px] text-slate-400">Shorts / Reels</div>
              </div>
            </button>

            <button type="button" id="presetLandscape" class="p-2.5 rounded-xl border border-white/10 hover:border-blue-500/50 bg-white/5 hover:bg-blue-500/10 text-left transition flex items-center gap-2">
              <span class="text-lg">💻</span>
              <div>
                <div class="font-bold text-white text-[11px]">16:9 Landscape</div>
                <div class="text-[10px] text-slate-400">Standard / YouTube</div>
              </div>
            </button>
          </div>

          <div class="p-2.5 bg-blue-500/10 border border-blue-500/20 rounded-xl text-[11px] text-blue-200 flex items-start gap-2">
            <i data-lucide="mouse-pointer-click" class="w-4 h-4 text-blue-400 shrink-0 mt-0.5"></i>
            <div>
              <strong>Click-to-Aim:</strong> Click directly on the watermark in the preview to position the removal box exactly over it!
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3 text-xs">
            <div>
              <label class="text-slate-400 block mb-1 font-semibold">Center X (pixels)</label>
              <input type="number" id="coordX" value="768" class="glass-input w-full px-3 py-2 rounded-lg font-mono text-white">
            </div>
            <div>
              <label class="text-slate-400 block mb-1 font-semibold">Center Y (pixels)</label>
              <input type="number" id="coordY" value="398" class="glass-input w-full px-3 py-2 rounded-lg font-mono text-white">
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3 text-xs">
            <div>
              <label class="text-slate-400 block mb-1 font-semibold">Box Size (px)</label>
              <input type="number" id="boxSize" value="44" class="glass-input w-full px-3 py-2 rounded-lg font-mono text-white">
            </div>
            <div>
              <label class="text-slate-400 block mb-1 font-semibold">Output Format</label>
              <select id="ratioSelect" class="glass-input w-full px-2 py-2 rounded-lg text-xs text-white">
                <option value="original">Keep Original Ratio (Recommended)</option>
                <option value="portrait916">Letterbox to 9:16 Canvas</option>
              </select>
            </div>
          </div>

          <button id="startBtn" class="w-full py-3.5 px-4 rounded-xl font-bold text-sm text-white bg-gradient-to-r from-pink-500 via-purple-600 to-blue-500 hover:opacity-95 transition shadow-lg shadow-pink-500/25 flex items-center justify-center gap-2">
            <i data-lucide="sparkles" class="w-4 h-4"></i>
            <span>Remove Watermark Now</span>
          </button>
        </div>

      </div>

      <!-- Right Column: Interactive Video Preview & Progress (7 cols) -->
      <div class="lg:col-span-7 space-y-6">

        <!-- Progress Card -->
        <div id="progressCard" class="hidden glass-card rounded-2xl p-6">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <div class="w-2.5 h-2.5 rounded-full bg-pink-500 animate-ping"></div>
              <span id="statusTitle" class="font-bold text-xs text-white">Processing Video...</span>
            </div>
            <span id="percentText" class="text-lg font-black font-mono text-pink-400">0%</span>
          </div>
          <div class="w-full h-2 rounded-full bg-slate-800 overflow-hidden mb-3">
            <div id="progressBar" class="h-full bg-gradient-to-r from-pink-500 to-blue-500 transition-all duration-200 w-0"></div>
          </div>
          <div class="flex justify-between text-[11px] font-mono text-slate-400">
            <span id="framesText">0 / 0 frames</span>
            <span id="speedText">-- fps</span>
          </div>
        </div>

        <!-- Video Player Card -->
        <div class="glass-card rounded-2xl p-6">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2">
              <i data-lucide="play-square" class="w-4 h-4 text-emerald-400"></i>
              Interactive Video Preview
            </h2>
            <div id="playerTabs" class="hidden flex gap-1 bg-slate-900/80 p-1 rounded-xl border border-white/10 text-xs font-semibold">
              <button id="tabClean" class="px-3 py-1 rounded-lg bg-pink-500 text-white shadow">Cleaned Video</button>
              <button id="tabOriginal" class="px-3 py-1 rounded-lg text-slate-400 hover:text-white">Original Video</button>
            </div>
          </div>

          <!-- Adaptive Video Container (dynamically scales to 9:16 or 16:9) -->
          <div id="videoContainer" class="relative rounded-xl overflow-hidden bg-black flex items-center justify-center border border-white/10 cursor-crosshair mx-auto transition-all" style="min-height: 380px; max-height: 600px;">
            <div id="playerPlaceholder" class="text-center p-8">
              <i data-lucide="film" class="w-8 h-8 text-slate-600 mx-auto mb-2"></i>
              <p class="text-xs text-slate-400 font-medium">Click on video to reposition watermark box</p>
            </div>

            <video id="originalVideo" controls playsinline class="hidden w-full h-full object-contain"></video>
            <video id="cleanedVideo" controls playsinline class="hidden w-full h-full object-contain"></video>

            <!-- Interactive Target Box Overlay -->
            <div id="boxOverlay" class="watermark-box-overlay hidden"></div>
          </div>

          <!-- Download Action -->
          <div id="actionButtons" class="hidden mt-6 flex gap-3">
            <a id="downloadBtn" href="#" download class="flex-1 py-3 px-4 rounded-xl font-bold text-xs text-center text-white bg-emerald-600 hover:bg-emerald-500 transition shadow-lg shadow-emerald-600/30 flex items-center justify-center gap-2">
              <i data-lucide="download" class="w-4 h-4"></i>
              Download Cleaned Video
            </a>
          </div>
        </div>

      </div>
    </div>
  </main>

  <script>
    lucide.createIcons();

    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const uploadPlaceholder = document.getElementById('uploadPlaceholder');
    const fileInfo = document.getElementById('fileInfo');
    const fileName = document.getElementById('fileName');
    const fileMeta = document.getElementById('fileMeta');
    const clearFile = document.getElementById('clearFile');
    const startBtn = document.getElementById('startBtn');
    const quickTestCurrent = document.getElementById('quickTestCurrent');

    const detectedFormatBadge = document.getElementById('detectedFormatBadge');
    const presetPortrait = document.getElementById('presetPortrait');
    const presetLandscape = document.getElementById('presetLandscape');

    const coordX = document.getElementById('coordX');
    const coordY = document.getElementById('coordY');
    const boxSize = document.getElementById('boxSize');
    const ratioSelect = document.getElementById('ratioSelect');

    const videoContainer = document.getElementById('videoContainer');
    const originalVideo = document.getElementById('originalVideo');
    const cleanedVideo = document.getElementById('cleanedVideo');
    const boxOverlay = document.getElementById('boxOverlay');
    const playerPlaceholder = document.getElementById('playerPlaceholder');

    const progressCard = document.getElementById('progressCard');
    const percentText = document.getElementById('percentText');
    const progressBar = document.getElementById('progressBar');
    const framesText = document.getElementById('framesText');
    const speedText = document.getElementById('speedText');
    const statusTitle = document.getElementById('statusTitle');

    const playerTabs = document.getElementById('playerTabs');
    const tabClean = document.getElementById('tabClean');
    const tabOriginal = document.getElementById('tabOriginal');
    const actionButtons = document.getElementById('actionButtons');
    const downloadBtn = document.getElementById('downloadBtn');

    let currentFile = null;
    let videoNaturalW = 848;
    let videoNaturalH = 478;

    quickTestCurrent.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/last_uploaded');
        if (!res.ok) throw new Error('No previous upload');
        const blob = await res.blob();
        const file = new File([blob], 'my_video.mp4', { type: 'video/mp4' });
        loadVideoFile(file);
      } catch (e) {
        console.log('Last uploaded not available on fresh server');
      }
    });

    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length) loadVideoFile(e.target.files[0]);
    });

    function applyPortraitPreset() {
      if (videoNaturalH > videoNaturalW) {
        // Native 9:16 video
        if (videoNaturalW === 720 && videoNaturalH === 1280) {
          coordX.value = 599;
          coordY.value = 1155;
          boxSize.value = 53;
        } else if (videoNaturalW === 1080 && videoNaturalH === 1920) {
          coordX.value = 899;
          coordY.value = 1733;
          boxSize.value = 80;
        } else {
          coordX.value = Math.round(videoNaturalW * (599 / 720));
          coordY.value = Math.round(videoNaturalH * (1155 / 1280));
          boxSize.value = Math.max(36, Math.min(100, Math.round(videoNaturalW * (53 / 720))));
        }
      } else {
        // Standard 720x1280 portrait preset
        coordX.value = 599;
        coordY.value = 1155;
        boxSize.value = 53;
      }
      updateTargetBox();
    }

    function applyLandscapePreset() {
      if (videoNaturalW === 848 && videoNaturalH === 478) {
        coordX.value = 768;
        coordY.value = 398;
        boxSize.value = 44;
      } else if (videoNaturalW === 1280 && videoNaturalH === 720) {
        coordX.value = 1160;
        coordY.value = 600;
        boxSize.value = 48;
      } else if (videoNaturalW === 1920 && videoNaturalH === 1080) {
        coordX.value = 1740;
        coordY.value = 900;
        boxSize.value = 64;
      } else {
        coordX.value = Math.round(videoNaturalW * 0.905);
        coordY.value = Math.round(videoNaturalH * 0.832);
        boxSize.value = Math.max(36, Math.min(80, Math.round(videoNaturalH * 0.085)));
      }
      updateTargetBox();
    }

    presetPortrait.addEventListener('click', () => {
      videoContainer.style.aspectRatio = '9/16';
      applyPortraitPreset();
      detectedFormatBadge.textContent = 'Mode: 9:16 Portrait (599, 1155)';
    });

    presetLandscape.addEventListener('click', () => {
      videoContainer.style.aspectRatio = '16/9';
      applyLandscapePreset();
      detectedFormatBadge.textContent = 'Mode: 16:9 Landscape';
    });

    function loadVideoFile(file) {
      currentFile = file;
      fileName.textContent = file.name;
      fileMeta.textContent = `${(file.size / (1024*1024)).toFixed(1)} MB`;
      uploadPlaceholder.classList.add('hidden');
      fileInfo.classList.remove('hidden');

      const objUrl = URL.createObjectURL(file);
      originalVideo.src = objUrl;
      originalVideo.classList.remove('hidden');
      cleanedVideo.classList.add('hidden');
      playerPlaceholder.classList.add('hidden');
      playerTabs.classList.add('hidden');
      actionButtons.classList.add('hidden');

      originalVideo.onloadedmetadata = () => {
        videoNaturalW = originalVideo.videoWidth;
        videoNaturalH = originalVideo.videoHeight;
        
        // Adapt container shape so portrait isn't squished
        if (videoNaturalH > videoNaturalW) {
          // 9:16 Portrait
          videoContainer.style.aspectRatio = '9/16';
          detectedFormatBadge.textContent = `Auto: 9:16 (${videoNaturalW}x${videoNaturalH})`;
          applyPortraitPreset();
        } else {
          // 16:9 Landscape
          videoContainer.style.aspectRatio = '16/9';
          detectedFormatBadge.textContent = `Auto: 16:9 (${videoNaturalW}x${videoNaturalH})`;
          applyLandscapePreset();
        }
      };
    }

    videoContainer.addEventListener('click', (e) => {
      if (!originalVideo.src || originalVideo.classList.contains('hidden')) return;
      const rect = originalVideo.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      if (clickX >= 0 && clickX <= rect.width && clickY >= 0 && clickY <= rect.height) {
        const scaleX = videoNaturalW / rect.width;
        const scaleY = videoNaturalH / rect.height;
        const mappedX = Math.round(clickX * scaleX);
        const mappedY = Math.round(clickY * scaleY);

        coordX.value = mappedX;
        coordY.value = mappedY;
        detectedFormatBadge.textContent = 'Custom Position';
        updateTargetBox();
      }
    });

    [coordX, coordY, boxSize].forEach(inp => inp.addEventListener('input', updateTargetBox));

    function updateTargetBox() {
      if (originalVideo.classList.contains('hidden')) return;
      const rect = originalVideo.getBoundingClientRect();
      const containerRect = videoContainer.getBoundingClientRect();

      const scaleX = rect.width / videoNaturalW;
      const scaleY = rect.height / videoNaturalH;

      const cx = parseInt(coordX.value) || 768;
      const cy = parseInt(coordY.value) || 398;
      const sz = parseInt(boxSize.value) || 44;

      const screenW = sz * scaleX;
      const screenH = sz * scaleY;
      const screenLeft = (rect.left - containerRect.left) + (cx - sz/2) * scaleX;
      const screenTop = (rect.top - containerRect.top) + (cy - sz/2) * scaleY;

      boxOverlay.style.width = `${screenW}px`;
      boxOverlay.style.height = `${screenH}px`;
      boxOverlay.style.left = `${screenLeft}px`;
      boxOverlay.style.top = `${screenTop}px`;
      boxOverlay.classList.remove('hidden');
    }

    window.addEventListener('resize', updateTargetBox);

    window.addEventListener('DOMContentLoaded', () => {
      quickTestCurrent.click();
    });

    // Start Cleaning Process
    startBtn.addEventListener('click', async () => {
      if (!currentFile) {
        alert('Please select a video first.');
        return;
      }

      startBtn.setAttribute('disabled', 'true');
      progressCard.classList.remove('hidden');
      percentText.textContent = '0%';
      progressBar.style.width = '0%';
      statusTitle.textContent = 'Removing Watermark...';

      const formData = new FormData();
      formData.append('file', currentFile);
      formData.append('cx', coordX.value);
      formData.append('cy', coordY.value);
      formData.append('box_size', boxSize.value);
      formData.append('ratio', ratioSelect.value);

      try {
        const res = await fetch('/api/clean_video', {
          method: 'POST',
          body: formData
        });

        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        const jobId = data.job_id;

        startProgressTracking(jobId);

      } catch (err) {
        alert('Error: ' + err.message);
        startBtn.removeAttribute('disabled');
      }
    });

    function startProgressTracking(jobId) {
      let isCompleted = false;

      const pollInterval = setInterval(async () => {
        if (isCompleted) {
          clearInterval(pollInterval);
          return;
        }
        try {
          const res = await fetch(`/api/job/${jobId}`);
          if (res.ok) {
            const data = await res.json();
            handleProgressUpdate(data);
            if (data.status === 'completed') {
              isCompleted = true;
              clearInterval(pollInterval);
            }
          }
        } catch (e) {
          // ignore transient poll errors
        }
      }, 500);

      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws/${jobId}`);

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          handleProgressUpdate(msg);
          if (msg.type === 'completed') {
            isCompleted = true;
            clearInterval(pollInterval);
          }
        };
      } catch (e) {
        // Handled by polling
      }
    }

    function handleProgressUpdate(msg) {
      if (msg.percent !== undefined) {
        percentText.textContent = `${msg.percent}%`;
        progressBar.style.width = `${msg.percent}%`;
      }
      if (msg.frame && msg.total) {
        framesText.textContent = `${msg.frame} / ${msg.total} frames`;
      }
      if (msg.fps) {
        speedText.textContent = `${msg.fps} fps`;
      }
      if (msg.status === 'completed' || msg.type === 'completed') {
        percentText.textContent = '100%';
        progressBar.style.width = '100%';
        statusTitle.textContent = 'Cleaned Successfully!';
        startBtn.removeAttribute('disabled');

        const outUrl = msg.output_url || `/api/video/${activeJobId || ''}`;
        cleanedVideo.src = outUrl;
        cleanedVideo.classList.remove('hidden');
        originalVideo.classList.add('hidden');
        boxOverlay.classList.add('hidden');
        playerTabs.classList.remove('hidden');
        actionButtons.classList.remove('hidden');
        downloadBtn.href = outUrl;

        selectTab('clean');
      }
    }

    tabClean.addEventListener('click', () => selectTab('clean'));
    tabOriginal.addEventListener('click', () => selectTab('original'));

    function selectTab(tab) {
      if (tab === 'clean') {
        tabClean.classList.add('bg-pink-500', 'text-white');
        tabClean.classList.remove('text-slate-400');
        tabOriginal.classList.remove('bg-pink-500', 'text-white');
        tabOriginal.classList.add('text-slate-400');
        cleanedVideo.classList.remove('hidden');
        originalVideo.classList.add('hidden');
        boxOverlay.classList.add('hidden');
      } else {
        tabOriginal.classList.add('bg-pink-500', 'text-white');
        tabOriginal.classList.remove('text-slate-400');
        tabClean.classList.remove('bg-pink-500', 'text-white');
        tabClean.classList.add('text-slate-400');
        originalVideo.classList.remove('hidden');
        cleanedVideo.classList.add('hidden');
        updateTargetBox();
      }
    }
  </script>
</body>
</html>
"""

@app.get("/", response_class=HTMLResponse)
async def get_index():
    return HTMLResponse(content=HTML_CONTENT)

@app.get("/api/last_uploaded")
async def get_last_uploaded():
    files = list(UPLOADS_DIR.glob("*_input.mp4"))
    if not files:
        raise HTTPException(status_code=404, detail="No uploads found")
    latest = max(files, key=os.path.getmtime)
    return FileResponse(latest, media_type="video/mp4")

@app.get("/api/job/{job_id}")
async def get_job_status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return jobs[job_id]

@app.post("/api/clean_video")
async def clean_video(
    file: UploadFile = File(...),
    cx: int = Form(768),
    cy: int = Form(398),
    box_size: int = Form(44),
    ratio: str = Form("original")
):
    job_id = str(uuid.uuid4())
    input_path = UPLOADS_DIR / f"{job_id}_input.mp4"
    output_path = OUTPUTS_DIR / f"{job_id}_clean.mp4"

    with open(input_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    jobs[job_id] = {
        "status": "started",
        "percent": 0,
        "frame": 0,
        "total": 0,
        "fps": 0,
        "output_url": f"/api/video/{job_id}_clean.mp4"
    }

    asyncio.create_task(run_precision_cleaner(job_id, input_path, output_path, cx, cy, box_size, ratio))
    return {"job_id": job_id}

async def run_precision_cleaner(job_id, input_path, output_path, cx, cy, box_size, ratio):
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, sync_process, job_id, input_path, output_path, cx, cy, box_size, ratio, loop)

def sync_process(job_id, input_path, output_path, cx, cy, box_size, ratio, loop):
    cap = cv2.VideoCapture(str(input_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    mask_full = np.zeros((h, w), dtype=np.uint8)
    
    x1 = max(0, cx - box_size // 2)
    y1 = max(0, cy - box_size // 2)
    x2 = min(w, x1 + box_size)
    y2 = min(h, y1 + box_size)
    bw, bh = x2 - x1, y2 - y1

    alpha_raw = cv2.imread(str(ALPHA_MASK_FILE), cv2.IMREAD_GRAYSCALE) if ALPHA_MASK_FILE.exists() else None
    if alpha_raw is not None:
        alpha_resized = cv2.resize(alpha_raw, (bw, bh))
        binary = (alpha_resized > 10).astype(np.uint8) * 255
        dilated = cv2.dilate(binary, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
        mask_full[y1:y2, x1:x2] = dilated
    else:
        cv2.circle(mask_full, (cx, cy), box_size // 2 + 2, 255, -1)

    if ratio == "portrait916":
        out_w, out_h = 1080, 1920
        scale = min(out_w / w, out_h / h)
        fit_w = int(round(w * scale)) - (int(round(w * scale)) % 2)
        fit_h = int(round(h * scale)) - (int(round(h * scale)) % 2)
        fit_x = (out_w - fit_w) // 2
        fit_y = (out_h - fit_h) // 2
        canvas = np.zeros((out_h, out_w, 3), dtype=np.uint8)
    else:
        out_w, out_h = w, h

    temp_raw = str(output_path) + ".temp.mp4"
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(temp_raw, fourcc, fps, (out_w, out_h))

    frame_idx = 0
    start_time = time.time()

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        clean_frame = cv2.inpaint(frame, mask_full, 3, cv2.INPAINT_TELEA)

        if ratio == "portrait916":
            scaled = cv2.resize(clean_frame, (fit_w, fit_h), interpolation=cv2.INTER_LANCZOS4)
            canvas.fill(0)
            canvas[fit_y:fit_y + fit_h, fit_x:fit_x + fit_w] = scaled
            out.write(canvas)
        else:
            out.write(clean_frame)

        frame_idx += 1
        if frame_idx % 12 == 0 or frame_idx == total_frames:
            pct = int((frame_idx / total_frames) * 100)
            elapsed = time.time() - start_time
            cur_fps = round(frame_idx / elapsed, 1) if elapsed > 0 else 0
            
            jobs[job_id]["percent"] = pct
            jobs[job_id]["frame"] = frame_idx
            jobs[job_id]["total"] = total_frames
            jobs[job_id]["fps"] = cur_fps

            asyncio.run_coroutine_threadsafe(
                broadcast_ws(job_id, {"type": "progress", "percent": pct, "frame": frame_idx, "total": total_frames, "fps": cur_fps}),
                loop
            )

    cap.release()
    out.release()

    ffmpeg_bin = get_ffmpeg_path()
    cmd = [
        ffmpeg_bin, '-y',
        '-i', temp_raw,
        '-i', str(input_path),
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'fast',
        '-crf', '16',
        '-map', '0:v:0',
        '-map', '1:a:0?',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        str(output_path)
    ]
    subprocess.run(cmd, capture_output=True, text=True)
    if os.path.exists(temp_raw):
        try: os.remove(temp_raw)
        except Exception: pass

    jobs[job_id]["status"] = "completed"
    jobs[job_id]["percent"] = 100

    asyncio.run_coroutine_threadsafe(
        broadcast_ws(job_id, {"type": "completed", "output_url": f"/api/video/{job_id}_clean.mp4"}),
        loop
    )

async def broadcast_ws(job_id: str, message: dict):
    if job_id in active_websockets:
        dead = []
        for ws in active_websockets[job_id]:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for d in dead:
            active_websockets[job_id].remove(d)

@app.websocket("/ws/{job_id}")
async def websocket_endpoint(websocket: WebSocket, job_id: str):
    await websocket.accept()
    if job_id not in active_websockets:
        active_websockets[job_id] = []
    active_websockets[job_id].append(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        if job_id in active_websockets and websocket in active_websockets[job_id]:
            active_websockets[job_id].remove(websocket)

@app.get("/api/video/{filename}")
async def get_video(filename: str):
    file_path = OUTPUTS_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found")
    return FileResponse(file_path, media_type="video/mp4")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8501))
    uvicorn.run("video_web_app:app", host="127.0.0.1", port=port, reload=False)
