from __future__ import annotations

import struct
from pathlib import Path

POINT_STRIDE_BYTES = 16


def point_count(path: Path) -> int:
    size = path.stat().st_size
    if size % POINT_STRIDE_BYTES:
        raise ValueError(f"invalid XYZI byte size for {path.name}: {size}")
    return size // POINT_STRIDE_BYTES


def read_first_points(path: Path, count: int = 4) -> list[tuple[float, float, float, float]]:
    with path.open("rb") as handle:
        data = handle.read(count * POINT_STRIDE_BYTES)
    if len(data) % POINT_STRIDE_BYTES:
        raise ValueError("point data is not aligned to 16-byte XYZI records")
    return list(struct.iter_unpack("<4f", data))


def validate_point_file(path: Path) -> None:
    point_count(path)
