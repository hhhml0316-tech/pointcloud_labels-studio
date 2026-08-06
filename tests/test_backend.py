from __future__ import annotations

import json
import os
import struct
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.config import AppConfig, SequenceConfig
from backend.indexer import index_sequence
from backend.labels import load_labels, save_labels, validate_labels
from backend.pointcloud import point_count, read_first_points


def write_bin(path: Path, points: list[tuple[float, float, float, float]]) -> None:
    path.write_bytes(b"".join(struct.pack("<4f", *point) for point in points))


def sample_labels() -> list[dict]:
    return [
        {
            "obj_id": "1",
            "obj_type": "Pedestrain",
            "obj_attr": {"source": "legacy"},
            "psr": {
                "position": {"x": 1.0, "y": 2.0, "z": 0.5},
                "scale": {"x": 0.7, "y": 0.7, "z": 1.6},
                "rotation": {"x": 0.0, "y": 0.0, "z": 0.2},
            },
        }
    ]


def test_bin_alignment_and_first_points(tmp_path: Path) -> None:
    path = tmp_path / "000002.bin"
    write_bin(path, [(1.0, 2.0, 3.0, 255.0), (4.0, 5.0, 6.0, 7.0)])
    assert point_count(path) == 2
    assert read_first_points(path) == [(1.0, 2.0, 3.0, 255.0), (4.0, 5.0, 6.0, 7.0)]

    path.write_bytes(b"123")
    with pytest.raises(ValueError):
        point_count(path)


def test_given_sample_if_available() -> None:
    sample_path = os.environ.get("POINTCLOUD_LABELS_SAMPLE")
    if not sample_path:
        pytest.skip("POINTCLOUD_LABELS_SAMPLE is not configured")
    sample = Path(sample_path)
    if not sample.is_file():
        pytest.skip("provided SUSTech sample is not available")
    assert point_count(sample) == 580283
    first = read_first_points(sample, 4)
    assert first[0] == pytest.approx((96.85225, 18.1947975, 3.568426, 9.0), rel=1e-6)
    assert min(point[3] for point in first) >= 1


def test_label_roundtrip_and_backup(tmp_path: Path) -> None:
    path = tmp_path / "label" / "000001.json"
    labels = sample_labels()
    result = save_labels(path, labels, {"Car", "Pedestrain"})
    assert result["backup_file"] is None
    assert load_labels(path) == labels

    updated = [dict(labels[0], obj_id="2")]
    result = save_labels(path, updated, {"Car", "Pedestrain"})
    assert result["backup_file"] == "000001.json.bak"
    assert load_labels(path) == updated
    assert json.loads((path.parent / "000001.json.bak").read_text(encoding="utf-8")) == labels


def test_validation_separates_warnings_from_errors() -> None:
    invalid_legacy = [
        {
            "obj_id": "17",
            "obj_type": "Truck",
            "psr": {
                "position": {"x": 0, "y": 0, "z": 0},
                "scale": {"x": 10, "y": -2, "z": 4},
                "rotation": {"x": 0, "y": 0, "z": 0},
            },
        }
    ]
    result = validate_labels(invalid_legacy, {"Truck"})
    assert result["errors"] == []
    assert result["warnings"]

    invalid_nan = json.loads(json.dumps(invalid_legacy))
    invalid_nan[0]["psr"]["position"]["x"] = float("nan")
    assert validate_labels(invalid_nan, {"Truck"})["errors"]


def test_index_natural_order_and_optional_labels(tmp_path: Path) -> None:
    lidar = tmp_path / "lidar"
    labels = tmp_path / "label"
    lidar.mkdir()
    labels.mkdir()
    for name in ("frame10.bin", "frame2.bin", "frame1.bin"):
        write_bin(lidar / name, [(0, 0, 0, 1)])
    (labels / "frame2.json").write_text("[]", encoding="utf-8")
    record = index_sequence(SequenceConfig("demo", lidar, labels))
    assert [frame.frame_id for frame in record.frames] == ["frame1", "frame2", "frame10"]
    assert record.frames[0].label_file is None
    assert record.frames[1].label_file == "frame2.json"


def test_api_loads_missing_label_and_creates_it(tmp_path: Path) -> None:
    lidar = tmp_path / "lidar"
    labels = tmp_path / "label"
    lidar.mkdir()
    write_bin(lidar / "frame1.bin", [(1, 2, 3, 4)])
    config = AppConfig(
        sequences=(SequenceConfig("demo", lidar, labels),),
        classes=({"id": "Car", "label": "Car"},),
    )
    client = TestClient(create_app(config))

    assert client.get("/api/health").json()["cuda_required"] is False
    assert client.get("/api/sequences/demo/frames/frame1/labels").json()["boxes"] == []
    response = client.put("/api/sequences/demo/frames/frame1/labels", json={"boxes": sample_labels()})
    assert response.status_code == 200
    assert (labels / "frame1.json").is_file()
    assert client.get("/api/sequences/demo/frames/frame1/points").status_code == 200
    assert client.get("/api/sequences/demo/frames/../labels").status_code in {404, 405}


def test_api_lidar_only_sequence_uses_sibling_label_dir(tmp_path: Path) -> None:
    lidar = tmp_path / "sequence" / "lidar"
    lidar.mkdir(parents=True)
    write_bin(lidar / "frame1.bin", [(1, 2, 3, 4)])
    config = AppConfig(sequences=(SequenceConfig("demo", lidar, None),), classes=({"id": "Car"},))
    client = TestClient(create_app(config))
    response = client.put("/api/sequences/demo/frames/frame1/labels", json={"boxes": []})
    assert response.status_code == 200
    assert (tmp_path / "sequence" / "label" / "frame1.json").is_file()
