"""Local HTTP + WebSocket API consumed by the desktop UI.

Bound to 127.0.0.1 only and protected by a per-launch random token that the
Electron main process generates and hands to the UI.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response

from . import __version__
from .cameras import list_cameras
from .detectors import preload_runtime
from .exporter import build_run_report
from .model_store import ModelStoreError, meta_to_json
from .schemas import ImportModelRequest, LibraryModelInfo, LiveSettingsPatch, RunMetaPatch, SessionRequest, StartRunRequest
from .station import Station, StationError

log = logging.getLogger(__name__)


class Broadcaster:
    """Fan-out to WebSocket clients. Frames are latest-only per client; events are queued."""

    class _Client:
        def __init__(self) -> None:
            self.frame: bytes | None = None
            self.events: asyncio.Queue[dict] = asyncio.Queue(maxsize=256)
            self.wake = asyncio.Event()

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._clients: set[Broadcaster._Client] = set()

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    # Called from worker threads.
    def publish_frame(self, packet: bytes) -> None:
        if self._loop is not None and self._clients:
            self._loop.call_soon_threadsafe(self._set_frame, packet)

    def publish_event(self, event: dict) -> None:
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._push_event, event)

    def _set_frame(self, packet: bytes) -> None:
        for c in self._clients:
            c.frame = packet
            c.wake.set()

    def _push_event(self, event: dict) -> None:
        for c in self._clients:
            if c.events.full():
                c.events.get_nowait()
            c.events.put_nowait(event)
            c.wake.set()

    async def serve(self, ws: WebSocket) -> None:
        client = self._Client()
        self._clients.add(client)
        try:
            while True:
                await client.wake.wait()
                client.wake.clear()
                while not client.events.empty():
                    await ws.send_json(client.events.get_nowait())
                if client.frame is not None:
                    frame, client.frame = client.frame, None
                    await ws.send_bytes(frame)
        finally:
            self._clients.discard(client)


def create_app(data_dir: Path, token: str) -> FastAPI:
    broadcaster = Broadcaster()
    station = Station(data_dir, broadcaster.publish_frame, broadcaster.publish_event)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        broadcaster.bind(asyncio.get_running_loop())
        threading.Thread(target=preload_runtime, name="preload", daemon=True).start()
        log.info("Engine %s ready (data dir %s)", __version__, data_dir)
        yield
        await asyncio.to_thread(station.shutdown)
        log.info("Engine stopped")

    app = FastAPI(title="Vision-M Station Engine", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.station = station
    # The UI is served from file:// (Origin "null") when packaged and from the Vite dev server in development.
    # Every request still needs the per-launch token; CORS only lets the app's own pages read responses.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(null|http://localhost:\d+|http://127\.0\.0\.1:\d+)$",
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["x-engine-token", "content-type"],
    )

    def check_token(supplied: str | None) -> None:
        if not supplied or not hmac.compare_digest(supplied, token):
            raise HTTPException(status_code=401, detail="Invalid engine token")

    def auth(request: Request, t: str | None = Query(default=None)) -> None:
        # Header for fetch(); query param for <img src> and WebSocket URLs.
        check_token(request.headers.get("x-engine-token") or t)

    @app.exception_handler(StationError)
    async def _station_error(_: Request, exc: StationError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content={"error": str(exc)})

    @app.exception_handler(ModelStoreError)
    async def _model_error(_: Request, exc: ModelStoreError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"error": str(exc)})

    @app.post("/shutdown", dependencies=[Depends(auth)])
    def shutdown() -> dict:
        # Graceful exit: lifespan shutdown stops the run and flushes everything to disk.
        request_exit = getattr(app.state, "request_exit", None)
        if request_exit:
            request_exit()
        return {"ok": True}

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "version": __version__}

    # ---------- session / status ----------

    @app.get("/status", dependencies=[Depends(auth)])
    def status() -> dict:
        return station.status()

    @app.get("/gpus", dependencies=[Depends(auth)])
    def gpus() -> dict:
        return station.gpu_info()

    @app.post("/session", dependencies=[Depends(auth)])
    def set_session(body: SessionRequest) -> dict:
        station.set_session(body.api_base, body.headers, body.user, body.station_name, body.upload_enabled)
        return {"ok": True}

    @app.delete("/session", dependencies=[Depends(auth)])
    def clear_session() -> dict:
        station.clear_session()
        return {"ok": True}

    # ---------- cameras ----------

    @app.get("/cameras", dependencies=[Depends(auth)])
    def cameras() -> dict:
        return {"cameras": [{"id": c.id, "kind": c.kind, "name": c.name} for c in list_cameras()]}

    # ---------- models ----------

    @app.get("/models", dependencies=[Depends(auth)])
    def models() -> dict:
        return {"models": [meta_to_json(m) for m in station.models.list()]}

    @app.post("/models/import", dependencies=[Depends(auth)])
    def import_model(body: ImportModelRequest) -> dict:
        return {"model": meta_to_json(station.models.import_file(Path(body.path), body.name, body.model_type))}

    @app.post("/models/download", dependencies=[Depends(auth)])
    def download_model(body: LibraryModelInfo) -> dict:
        session = station.sync._session  # noqa: SLF001 - the engine holds one backend session
        if session is None:
            raise StationError("Sign in before downloading library models", 401)
        info = body.model_dump(by_alias=True)
        job = station.models.start_download(api_base=session.api_base, headers=session.headers, info=info)
        return {"job": job.to_json()}

    @app.get("/models/download/{job_id}", dependencies=[Depends(auth)])
    def download_status(job_id: str) -> dict:
        job = station.models.job(job_id)
        if job is None:
            raise HTTPException(404, "Unknown download")
        return {"job": job.to_json()}

    @app.delete("/models/{model_id}", dependencies=[Depends(auth)])
    def delete_model(model_id: str) -> dict:
        if station._detector_key and station._detector_key[0] == model_id:  # noqa: SLF001
            station.unload_model()
        station.models.delete(model_id)
        return {"ok": True}

    # ---------- runs ----------

    @app.post("/runs/start", dependencies=[Depends(auth)])
    def start_run(body: StartRunRequest) -> dict:
        return station.start_run(body)

    @app.post("/runs/stop", dependencies=[Depends(auth)])
    def stop_run() -> dict:
        return {"run": station.stop_run()}

    @app.patch("/runs/live", dependencies=[Depends(auth)])
    def update_live(body: LiveSettingsPatch) -> dict:
        return {"live": station.update_live(body)}

    @app.get("/runs", dependencies=[Depends(auth)])
    def list_runs(limit: int = 200) -> dict:
        return {"runs": station.runs.list_runs(min(max(limit, 1), 1000))}

    @app.get("/runs/{run_id}", dependencies=[Depends(auth)])
    def get_run(run_id: str) -> dict:
        run = station.runs.get_run(run_id)
        if run is None:
            raise HTTPException(404, "Run not found")
        return {"run": run, "defects": station.runs.list_defects(run_id)}

    @app.patch("/runs/{run_id}", dependencies=[Depends(auth)])
    def update_run(run_id: str, body: RunMetaPatch) -> dict:
        if not station.runs.update_meta(run_id, body.name, body.notes):
            raise HTTPException(404, "Run not found")
        return {"run": station.runs.get_run(run_id)}

    @app.delete("/runs/{run_id}", dependencies=[Depends(auth)])
    def delete_run(run_id: str) -> dict:
        active = station._run  # noqa: SLF001
        if active is not None and active.run_id == run_id:
            raise StationError("Stop the run before deleting it", 409)
        station.runs.delete_run(run_id)
        return {"ok": True}

    @app.get("/runs/{run_id}/defects/{defect_id}/image", dependencies=[Depends(auth)])
    def defect_image(run_id: str, defect_id: str) -> FileResponse:
        path = station.runs.defect_image_path(run_id, defect_id)
        if path is None:
            raise HTTPException(404, "Image not found")
        return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=31536000, immutable"})

    @app.get("/runs/{run_id}/report.xlsx", dependencies=[Depends(auth)])
    def run_report(run_id: str) -> Response:
        try:
            data = build_run_report(station.runs, run_id)
        except KeyError:
            raise HTTPException(404, "Run not found") from None
        return Response(
            data,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="{run_id}.xlsx"'},
        )

    @app.post("/sync/now", dependencies=[Depends(auth)])
    def sync_now() -> dict:
        station.sync.nudge()
        return {"ok": True}

    # ---------- stream ----------

    @app.websocket("/ws")
    async def ws_stream(ws: WebSocket, t: str | None = Query(default=None)) -> None:
        if not t or not hmac.compare_digest(t, token):
            await ws.close(code=4401)
            return
        await ws.accept()
        await ws.send_json({"type": "status", "status": await asyncio.to_thread(station.status)})
        try:
            await broadcaster.serve(ws)
        except (WebSocketDisconnect, RuntimeError):
            pass

    return app
