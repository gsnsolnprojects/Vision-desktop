# Vision-M Station

Windows desktop app for running Vision-M models on a production line. Camera capture and inference run on the station's own NVIDIA GPU; nothing is sent over the network per frame.

## Architecture

```
Electron UI (React)  ──localhost HTTP/WebSocket + secret token──▶  Python engine (engine/)
   login (Supabase)                                                 camera thread → GPU inference thread → publisher
   backend calls via main process                                   verdict / counts / defect log (port of Studio logic)
   first-run AI runtime installer                                   SQLite run store (crash-safe) → background sync to VisionBackend
```

- `src/main` – window, engine supervisor (auto-restart, graceful shutdown), first-run runtime installer, backend proxy, settings
- `src/renderer` – screens: Login, Models, Run Setup, Live Inspection, Reports, Settings
- `engine/visionm_engine` – inference engine
  - `cameras/` – USB webcams (`uvc.py`) and industrial GenICam cameras (`genicam.py`, see below)
  - `detectors.py` – YOLO (Ultralytics) and RF-DETR, FP32 / FP16; `tensorrt_opt.py` – TensorRT engines
  - `verdict.py` – OK / NOT_OK logic, identical to Vision-M Studio
  - `maintenance.py` – snapshot retention and low-disk protection
- `backend/` – copies of the `/api/station/...` endpoints (installed in VisionBackend)

## Features at a glance

| Area | What it does |
|---|---|
| Models | Download from the model library or load a `.pt` / `.pth` / `.onnx` file; **Optimize for this GPU** builds a TensorRT engine (~2× faster, YOLO) |
| Run Setup | Model, camera, resolution, **Auto** frame rate, precision (Accurate / Fast / Fastest-TensorRT), inspection rules; lockable presets |
| Live | Real-time verdict, counts, defect log; warnings for dark picture / slow camera / reconnecting |
| Reports | Run history, analytics, defect snapshots, Excel export, save / delete after each run |
| Settings | Backend URL, uploads on/off, GPU info + selection, snapshot retention + disk usage |

## Installing on a station (production)

Build the installer on a Windows dev machine that has 64-bit **Python 3.10** installed:

```bash
npm install
npm run dist          # → release/Vision-M-Station-Setup-<version>.exe (~150 MB)
```

On the station:

1. Install the NVIDIA driver (any driver supporting CUDA 12.1, i.e. 525 or newer).
2. Run `Vision-M-Station-Setup-<version>.exe` (per-user install, no admin needed).
3. First launch shows **Setting up AI runtime** and downloads PyTorch / CUDA / TensorRT once
   (~4 GB, needs internet and ~12 GB free disk). Versions are pinned in `engine/requirements.lock`.
   After that the station starts in seconds and works offline.

Data (models, runs, snapshots, logs, AI runtime) lives in `%APPDATA%\Vision-M Station\`.

### Industrial cameras (GenICam)

Install the camera vendor's SDK (Basler pylon, Hikvision MVS, IDS peak, …). Its installer sets
`GENICAM_GENTL64_PATH`; the station then lists those cameras next to webcams. Supported pixel
formats: BGR8, RGB8, Mono8, Bayer*8. *Not yet validated on real industrial hardware.*

## Development

```bash
# one-time: engine environment (reuses a system CUDA PyTorch install)
cd engine
python -m venv --system-site-packages .venv
.venv/Scripts/python -m pip install -r requirements.txt

# app
cd ..
npm install
cp .env.example .env   # Supabase URL + publishable key
npm run dev
```

Tests: `npm run test:engine` (verdict parity, run store, retention, cameras, pipeline) and `npm run typecheck`.
Debug the renderer with `VISIONM_DEBUG_PORT=9223 npm run dev` (DevTools protocol on localhost).
