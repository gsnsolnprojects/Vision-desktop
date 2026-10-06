"""Request / response models for the engine's local HTTP API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class LiveSettings(ApiModel):
    """Settings that can change while a run is live."""

    confidence: float = Field(0.25, ge=0.01, le=1.0)
    good_classes: list[str] = Field(default_factory=lambda: ["product"])
    verdict_enabled: bool = True
    defect_logging_enabled: bool = True
    center_guide_enabled: bool = True
    center_guide_percent: float = Field(40, ge=40, le=95)


class LiveSettingsPatch(ApiModel):
    confidence: float | None = Field(None, ge=0.01, le=1.0)
    good_classes: list[str] | None = None
    verdict_enabled: bool | None = None
    defect_logging_enabled: bool | None = None
    center_guide_enabled: bool | None = None
    center_guide_percent: float | None = Field(None, ge=40, le=95)


class CameraConfig(ApiModel):
    camera_id: str
    camera_name: str | None = None
    width: int = Field(1280, ge=160, le=7680)
    height: int = Field(720, ge=120, le=4320)
    fps: int = Field(0, ge=0, le=240)  # 0 = auto (fastest the camera sustains)


class StartRunRequest(ApiModel):
    model_id: str
    camera: CameraConfig
    live: LiveSettings = Field(default_factory=LiveSettings)
    precision: Literal["fp32", "fp16"] = "fp32"
    gpu_index: int | None = Field(None, ge=0, le=15)  # None = first NVIDIA GPU
    stream_quality: int = Field(80, ge=40, le=95)
    preset_name: str | None = None


class UserIdentity(ApiModel):
    id: str
    email: str | None = None
    role: str | None = None
    company: str | None = None
    company_id: str | None = None


class SessionRequest(ApiModel):
    """Sent by the UI after login and on every token refresh so the engine can sync to the backend."""

    api_base: str
    headers: dict[str, str]
    user: UserIdentity
    station_name: str | None = None
    upload_enabled: bool = False


class RunMetaPatch(ApiModel):
    name: str | None = Field(None, max_length=120)
    notes: str | None = Field(None, max_length=2000)


class ImportModelRequest(ApiModel):
    path: str
    name: str | None = None
    model_type: str | None = None


class LibraryModelInfo(ApiModel):
    model_id: str
    name: str | None = None
    model_type: str | None = None
    model_version: str | int | None = None
    class_names: list[str] = Field(default_factory=list)
    metrics: dict | None = None
    company: str | None = None
    project: str | None = None
    project_id: str | None = None
