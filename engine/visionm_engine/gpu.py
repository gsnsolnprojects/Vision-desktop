"""GPU discovery, selection and live health (NVIDIA only — the inference stack is CUDA).

CUDA_DEVICE_ORDER=PCI_BUS_ID is set at engine start-up so CUDA device N and NVML device N
are the same physical GPU on multi-GPU machines.
"""

from __future__ import annotations

import logging
import threading

log = logging.getLogger(__name__)

_nvml_lock = threading.Lock()
_nvml_ready: bool | None = None


def _nvml():
    """pynvml module after nvmlInit, or None when no NVIDIA driver is present."""
    global _nvml_ready
    with _nvml_lock:
        if _nvml_ready is False:
            return None
        try:
            import pynvml

            if not _nvml_ready:
                pynvml.nvmlInit()
                _nvml_ready = True
            return pynvml
        except Exception as exc:
            if _nvml_ready is None:
                log.info("NVIDIA management library unavailable (%s); GPU health will not be shown", exc)
            _nvml_ready = False
            return None


def _torch_cuda():
    try:
        import torch

        return torch if torch.cuda.is_available() else None
    except Exception:
        return None


def _decode(v) -> str:
    return v.decode() if isinstance(v, bytes) else str(v)


def live_stats(index: int) -> dict | None:
    """Utilisation %, memory and temperature of one GPU. Cheap enough to poll every second or two."""
    nv = _nvml()
    if nv is None:
        return None
    try:
        h = nv.nvmlDeviceGetHandleByIndex(index)
        mem = nv.nvmlDeviceGetMemoryInfo(h)
        util = nv.nvmlDeviceGetUtilizationRates(h)
        out = {
            "utilization": int(util.gpu),
            "memoryUsedMb": int(mem.used // 2**20),
            "memoryTotalMb": int(mem.total // 2**20),
            "temperatureC": int(nv.nvmlDeviceGetTemperature(h, nv.NVML_TEMPERATURE_GPU)),
        }
        try:
            out["powerW"] = round(nv.nvmlDeviceGetPowerUsage(h) / 1000, 1)
        except Exception:
            pass  # not supported on many laptop GPUs
        return out
    except Exception:
        return None


def system_info() -> dict:
    """Everything the Settings screen shows about the GPUs on this PC."""
    torch = _torch_cuda()
    nv = _nvml()
    gpus: list[dict] = []
    count = torch.cuda.device_count() if torch else 0
    for i in range(count):
        props = torch.cuda.get_device_properties(i)
        gpus.append(
            {
                "index": i,
                "name": props.name,
                "memoryTotalMb": int(props.total_memory // 2**20),
                "computeCapability": f"{props.major}.{props.minor}",
                "live": live_stats(i),
            }
        )
    driver = None
    if nv is not None:
        try:
            driver = _decode(nv.nvmlSystemGetDriverVersion())
        except Exception:
            pass
        if not gpus:  # driver present but CUDA unusable (e.g. driver too old for this CUDA build)
            try:
                for i in range(nv.nvmlDeviceGetCount()):
                    h = nv.nvmlDeviceGetHandleByIndex(i)
                    gpus.append({"index": i, "name": _decode(nv.nvmlDeviceGetName(h)), "memoryTotalMb": int(nv.nvmlDeviceGetMemoryInfo(h).total // 2**20), "usable": False})
            except Exception:
                pass
    cuda_version = None
    try:
        import torch as _t

        cuda_version = _t.version.cuda
    except Exception:
        pass
    return {"cuda": torch is not None, "cudaVersion": cuda_version, "driverVersion": driver, "gpus": gpus}


def resolve_device(gpu_index: int | None) -> str:
    """'cuda:N' for a valid requested GPU (default the first), else 'cpu'."""
    torch = _torch_cuda()
    if torch is None:
        return "cpu"
    count = torch.cuda.device_count()
    if gpu_index is None or not 0 <= gpu_index < count:
        if gpu_index is not None:
            log.warning("GPU %s not found (%s available); using GPU 0", gpu_index, count)
        return "cuda:0"
    return f"cuda:{gpu_index}"
