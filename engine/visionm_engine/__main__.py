"""Entry point: `python -m visionm_engine --port 0 --token <secret> --data-dir <dir>`.

Prints one line `ENGINE_READY port=<port>` on stdout once it is accepting
connections; the Electron main process waits for that line.
"""

from __future__ import annotations

import argparse
import logging
import logging.handlers
import os
import socket
import sys
import threading
import time
from pathlib import Path


def _setup_logging(log_dir: Path) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s [%(threadName)s] %(name)s: %(message)s")
    file_handler = logging.handlers.RotatingFileHandler(log_dir / "engine.log", maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8")
    file_handler.setFormatter(fmt)
    stream_handler = logging.StreamHandler(sys.stderr)
    stream_handler.setFormatter(fmt)
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(file_handler)
    root.addHandler(stream_handler)
    for noisy in ("uvicorn.access", "httpx", "ultralytics"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def _watch_parent(parent_pid: int) -> None:
    """Exit if the desktop app dies, so the engine never lingers holding the camera and GPU."""
    import psutil

    try:
        parent = psutil.Process(parent_pid)
    except psutil.NoSuchProcess:
        os._exit(0)
    while True:
        if not parent.is_running():
            logging.getLogger(__name__).warning("Parent process %s exited; shutting down", parent_pid)
            os._exit(0)
        time.sleep(2)


def main() -> None:
    # Make CUDA device N == NVML device N (physical PCI order) on multi-GPU PCs; must be set before torch loads.
    os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID")
    parser = argparse.ArgumentParser(prog="visionm_engine")
    parser.add_argument("--port", type=int, default=0, help="0 = pick a free port")
    parser.add_argument("--token", default=os.environ.get("VISIONM_ENGINE_TOKEN"))
    parser.add_argument("--data-dir", type=Path, default=Path.home() / ".visionm-station")
    parser.add_argument("--parent-pid", type=int, default=None)
    args = parser.parse_args()

    if not args.token:
        parser.error("--token (or VISIONM_ENGINE_TOKEN) is required")

    data_dir: Path = args.data_dir
    data_dir.mkdir(parents=True, exist_ok=True)
    _setup_logging(data_dir / "logs")

    if args.parent_pid:
        threading.Thread(target=_watch_parent, args=(args.parent_pid,), name="parent-watch", daemon=True).start()

    import uvicorn

    from .server import create_app

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", args.port))
    port = sock.getsockname()[1]

    app = create_app(data_dir, args.token)
    config = uvicorn.Config(app, log_config=None, ws_max_size=16 * 1024 * 1024, access_log=False)
    server = uvicorn.Server(config)

    def request_exit() -> None:
        server.should_exit = True

    app.state.request_exit = request_exit

    original_startup = server.startup

    async def startup(sockets=None):
        await original_startup(sockets=sockets)
        print(f"ENGINE_READY port={port}", flush=True)
        # From here on stdout carries nothing the app needs. Libraries (TensorRT, Ultralytics) print a lot,
        # some from native code; point fd 1 at stderr so a reader that only wanted the handshake can never
        # make the engine block on a full stdout pipe.
        sys.stdout.flush()
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())

    server.startup = startup  # type: ignore[method-assign]
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()
