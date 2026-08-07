from __future__ import annotations

import json
import os
import struct
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.config import AppConfig, SequenceConfig, load_config
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


def test_api_remap_track_id_across_sequence(tmp_path: Path) -> None:
    lidar = tmp_path / "lidar"
    labels = tmp_path / "label"
    lidar.mkdir()
    labels.mkdir()
    for name in ("frame1.bin", "frame2.bin", "frame3.bin"):
        write_bin(lidar / name, [(1, 2, 3, 4)])

    box_a = sample_labels()[0]
    box_b = {**sample_labels()[0], "obj_id": "2"}
    box_conflict = {**sample_labels()[0], "obj_id": "9"}
    (labels / "frame1.json").write_text(json.dumps([box_a]), encoding="utf-8")
    (labels / "frame2.json").write_text(json.dumps([box_a, box_conflict]), encoding="utf-8")
    (labels / "frame3.json").write_text(json.dumps([box_b]), encoding="utf-8")

    config = AppConfig(
        sequences=(SequenceConfig("demo", lidar, labels),),
        classes=({"id": "Car", "label": "Car"}, {"id": "Pedestrain", "label": "Pedestrian"}),
    )
    client = TestClient(create_app(config))

    response = client.post("/api/sequences/demo/remap-track-id", json={"from_id": "1", "to_id": "9"})
    assert response.status_code == 200
    payload = response.json()
    # frame2 contains both ID 1 and ID 9, so it must be skipped, not merged.
    assert payload["updated_frames"] == ["frame1"]
    assert [item["frame_id"] for item in payload["skipped_frames"]] == ["frame2"]
    assert [box["obj_id"] for box in json.loads((labels / "frame1.json").read_text(encoding="utf-8"))] == ["9"]
    assert (labels / "frame1.json.bak").is_file()

    response = client.post("/api/sequences/demo/remap-track-id", json={"from_id": "2", "to_id": "7"})
    assert response.status_code == 200
    assert response.json()["updated_frames"] == ["frame3"]
    assert [box["obj_id"] for box in json.loads((labels / "frame3.json").read_text(encoding="utf-8"))] == ["7"]

    response = client.post("/api/sequences/demo/remap-track-id", json={"from_id": "4", "to_id": "4"})
    assert response.status_code == 422


def test_ai_box_config_is_merged_and_exposed(tmp_path: Path) -> None:
    lidar = tmp_path / "lidar"
    lidar.mkdir()
    write_bin(lidar / "frame1.bin", [(1, 2, 3, 4)])
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "\n".join(
            [
                "sequences:",
                "  - id: demo",
                "    lidar_dir: ./lidar",
                "ai_box:",
                "  roadGap: 0.25",
                "  angleSearch:",
                "    round2Count: 17",
            ]
        ),
        encoding="utf-8",
    )
    config = load_config(config_path)
    assert config.ai_box["roadGap"] == 0.25
    assert config.ai_box["roadGridSize"] == 2.0
    assert config.ai_box["angleSearch"] == {
        "round1Count": 10,
        "round2Count": 17,
        "round3Count": 9,
    }
    response = TestClient(create_app(config)).get("/api/config/ai-box")
    assert response.status_code == 200
    assert response.json()["roadGap"] == 0.25
