from __future__ import annotations

import re
from pathlib import Path

from .config import AppConfig, SequenceConfig
from .models import FrameInfo, SequenceRecord
from .pointcloud import point_count


def natural_key(value: str) -> list[int | str]:
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", value)]


def index_sequence(config: SequenceConfig) -> SequenceRecord:
    files = [path for path in config.lidar_dir.iterdir() if path.is_file() and path.suffix.casefold() == ".bin"]
    files.sort(key=lambda path: natural_key(path.stem))
    frames: list[FrameInfo] = []
    for path in files:
        label_path = config.label_dir / f"{path.stem}.json" if config.label_dir else None
        if label_path and not label_path.is_file():
            label_path = None
        frames.append(
            FrameInfo(
                frame_id=path.stem,
                point_file=path.name,
                label_file=label_path.name if label_path else None,
                point_count=point_count(path),
                byte_size=path.stat().st_size,
            )
        )
    return SequenceRecord(config.id, config.lidar_dir, config.label_dir, config.frame_rate, tuple(frames))


def index_config(config: AppConfig) -> dict[str, SequenceRecord]:
    return {item.id: index_sequence(item) for item in config.sequences}
