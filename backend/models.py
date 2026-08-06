from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class FrameInfo:
    frame_id: str
    point_file: str
    label_file: str | None
    point_count: int
    byte_size: int

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SequenceInfo:
    sequence_id: str
    frame_rate: float
    frame_count: int
    has_labels: bool

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SequenceRecord:
    sequence_id: str
    lidar_dir: Path
    label_dir: Path | None
    frame_rate: float
    frames: tuple[FrameInfo, ...]

    @property
    def info(self) -> SequenceInfo:
        return SequenceInfo(
            sequence_id=self.sequence_id,
            frame_rate=self.frame_rate,
            frame_count=len(self.frames),
            has_labels=any(frame.label_file for frame in self.frames),
        )

    def frame(self, frame_id: str) -> FrameInfo:
        for item in self.frames:
            if item.frame_id == frame_id:
                return item
        raise KeyError(frame_id)
