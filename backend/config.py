from __future__ import annotations

import copy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


DEFAULT_CLASSES = [
    {"id": "Car", "label": "Car", "color": "#3B82F6", "default_size": [4.5, 2.0, 1.6]},
    {"id": "Truck", "label": "Truck", "color": "#F97316", "default_size": [10.0, 2.8, 3.8]},
    {"id": "Chemical", "label": "Chemical", "color": "#A855F7", "default_size": [10.0, 3.0, 3.5]},
    {"id": "Pedestrain", "label": "Pedestrian", "color": "#22C55E", "default_size": [0.7, 0.7, 1.6]},
]


DEFAULT_AI_BOX_CONFIG: dict[str, Any] = {
    "enabled": False,
    "minBoxSize": 0.2,
    "heightRange": [-10000, 10000],
    "roadGridSize": 2.0,
    "roadZStatSigmaLow": 2,
    "roadZStatSigmaHigh": 1,
    "roadCellLowestMargin": 0.5,
    "roadOutlierK": 10,
    "roadOutlierStdMul": 0,
    "roadMaxSlopeDeg": 5,
    "roadSlopeSearchMul": 20,
    "roadQueryZOffset": 0.1,
    "roadGap": 0.1,
    "minPointsAfterRoadFilter": 10,
    "enableDenoise": True,
    "minFilterPoints": 100,
    "dbscanEps": 0.5,
    "dbscanMinPts": 3,
    "angleSearch": {"round1Count": 10, "round2Count": 11, "round3Count": 9},
    "edgeGap": 0.5,
    "lossScale": 50,
    "preferLongEdgeAsX": True,
    "useHeadAngle": True,
    "headFlipThresholdRad": 1.5707963267948966,
    "existingBoxFitPaddingRatio": 0.2,
    "useWorker": True,
}


@dataclass(frozen=True)
class SequenceConfig:
    id: str
    lidar_dir: Path
    label_dir: Path | None = None
    point_format: str = "xyz_i_float32_le"
    frame_rate: float = 10.0


@dataclass(frozen=True)
class AppConfig:
    sequences: tuple[SequenceConfig, ...]
    classes: tuple[dict[str, Any], ...] = field(default_factory=tuple)
    host: str = "127.0.0.1"
    port: int = 8000
    cors_origins: tuple[str, ...] = ("http://127.0.0.1:5173", "http://localhost:5173")
    ai_box: dict[str, Any] = field(default_factory=lambda: copy.deepcopy(DEFAULT_AI_BOX_CONFIG))


def _resolve_path(value: str | None, base_dir: Path) -> Path | None:
    if value is None or str(value).strip() == "":
        return None
    path = Path(str(value)).expanduser()
    if not path.is_absolute():
        path = base_dir / path
    return path.resolve()


def load_config(path: str | Path) -> AppConfig:
    config_path = Path(path).expanduser().resolve()
    with config_path.open("r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}

    sequence_items = raw.get("sequences") or []
    if not sequence_items:
        raise ValueError("config must define at least one sequence")

    sequences: list[SequenceConfig] = []
    seen_ids: set[str] = set()
    for item in sequence_items:
        if not isinstance(item, dict):
            raise ValueError("each sequence must be a mapping")
        sequence_id = str(item.get("id", "")).strip()
        lidar_dir = _resolve_path(item.get("lidar_dir"), config_path.parent)
        if not sequence_id or lidar_dir is None:
            raise ValueError("each sequence requires id and lidar_dir")
        if sequence_id in seen_ids:
            raise ValueError(f"duplicate sequence id: {sequence_id}")
        if not lidar_dir.is_dir():
            raise ValueError(f"lidar_dir does not exist: {lidar_dir}")
        seen_ids.add(sequence_id)
        label_dir = _resolve_path(item.get("label_dir"), config_path.parent)
        point_format = str(item.get("point_format", "xyz_i_float32_le"))
        if point_format != "xyz_i_float32_le":
            raise ValueError(f"unsupported point_format: {point_format}")
        frame_rate = float(item.get("frame_rate", 10.0))
        if frame_rate <= 0:
            raise ValueError("frame_rate must be positive")
        sequences.append(SequenceConfig(sequence_id, lidar_dir, label_dir, point_format, frame_rate))

    class_items = raw.get("classes") or DEFAULT_CLASSES
    if not isinstance(class_items, list):
        raise ValueError("classes must be a list")
    classes: list[dict[str, Any]] = []
    for item in class_items:
        if isinstance(item, str):
            classes.append({"id": item, "label": item, "color": "#94A3B8", "default_size": [4, 2, 1.5]})
        elif isinstance(item, dict) and str(item.get("id", "")).strip():
            normalized = dict(item)
            normalized.setdefault("label", normalized["id"])
            normalized.setdefault("color", "#94A3B8")
            normalized.setdefault("default_size", [4, 2, 1.5])
            classes.append(normalized)
        else:
            raise ValueError("each class must be a string or mapping with id")

    server = raw.get("server") or {}
    ai_box_raw = raw.get("ai_box") or {}
    if not isinstance(ai_box_raw, dict):
        raise ValueError("ai_box must be a mapping")
    ai_box = copy.deepcopy(DEFAULT_AI_BOX_CONFIG)
    ai_box.update({key: value for key, value in ai_box_raw.items() if key != "angleSearch"})
    angle_search = ai_box_raw.get("angleSearch") or {}
    if not isinstance(angle_search, dict):
        raise ValueError("ai_box.angleSearch must be a mapping")
    ai_box["angleSearch"] = {**DEFAULT_AI_BOX_CONFIG["angleSearch"], **angle_search}
    cors = tuple(server.get("cors_origins") or AppConfig.cors_origins)
    return AppConfig(
        sequences=tuple(sequences),
        classes=tuple(classes),
        host=str(server.get("host", "127.0.0.1")),
        port=int(server.get("port", 8000)),
        cors_origins=cors,
        ai_box=ai_box,
    )
