# Vision-M Station

Windows desktop app for running Vision-M models on a production line. Camera capture and inference run on the station's own NVIDIA GPU; nothing is sent over the network per frame.

## Architecture

```
Electron UI (React)  ──localhost HTTP/WebSocket + secret token──▶  Python engine (engine/)
   login (Supabase)                                                 camera thread → GPU inference thread → publisher
   backend calls via main process                                   verdict / counts / defect log (port of Studio logic)
                                                                    SQLite run store (crash-safe) → background sync to VisionBackend
```

- `src/main` – window, engine supervisor (auto-restart, graceful shutdown), backend proxy, settings
- `src/renderer` – screens: Login, Models, Run Setup, Live Inspection, Reports, Settings
- `engine/visionm_engine` – inference engine (`cameras/` is pluggable for industrial cameras later)
- `backend/` – `/api/station/...` endpoints that receive runs + defect snapshots; install them into VisionBackend (see `backend/README.md`)

## Development

```bash
# one-time: engine environment (reuses the system CUDA PyTorch / ultralytics / rfdetr)
cd engine
python -m venv --system-site-packages .venv
.venv/Scripts/python -m pip install fastapi "uvicorn[standard]" openpyxl cv2-enumerate-cameras httpx nvidia-ml-py pytest

# app
cd ..
npm install
cp .env.example .env   # Supabase URL + publishable key
npm run dev
```

Tests: `npm run test:engine` (verdict logic parity, run store, Excel report) and `npm run typecheck`.

Data (models, runs, snapshots, logs) lives in `%APPDATA%/visionm-station/station/`.
