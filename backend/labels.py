from __future__ import annotations

import json
import math
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any


REQUIRED_PSR_FIELDS = ("position", "scale", "rotation")
REQUIRED_VECTOR_FIELDS = ("x", "y", "z")


def load_labels(path: Path | None) -> list[dict[str, Any]]:
    if path is None or not path.is_file():
        return []
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, list):
        raise ValueError("label JSON root must be an array")
    return value


def _number(value: Any, location: str, errors: list[str]) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        errors.append(f"{location} must be numeric")
        return None
    number = float(value)
    if not math.isfinite(number):
        errors.append(f"{location} must be finite")
        return None
    return number


def validate_labels(labels: Any, known_classes: set[str]) -> dict[str, list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(labels, list):
        return {"errors": ["label JSON root must be an array"], "warnings": []}

    ids: dict[str, int] = {}
    for index, box in enumerate(labels):
        prefix = f"box[{index}]"
        if not isinstance(box, dict):
            errors.append(f"{prefix} must be an object")
            continue
        obj_type = box.get("obj_type")
        if not isinstance(obj_type, str) or not obj_type.strip():
            errors.append(f"{prefix}.obj_type must be a non-empty string")
        elif known_classes and obj_type not in known_classes:
            warnings.append(f"{prefix}.obj_type is not in class configuration: {obj_type}")

        obj_id = box.get("obj_id")
        if obj_id is None or str(obj_id).strip() == "":
            warnings.append(f"{prefix}.obj_id is empty")
        else:
            key = str(obj_id)
            if key in ids:
                warnings.append(f"duplicate obj_id {key} in box[{ids[key]}] and box[{index}]")
            else:
                ids[key] = index

        psr = box.get("psr")
        if not isinstance(psr, dict):
            errors.append(f"{prefix}.psr must be an object")
            continue
        for field in REQUIRED_PSR_FIELDS:
            vector = psr.get(field)
            if not isinstance(vector, dict):
                errors.append(f"{prefix}.psr.{field} must be an object")
                continue
            for axis in REQUIRED_VECTOR_FIELDS:
                _number(vector.get(axis), f"{prefix}.psr.{field}.{axis}", errors)
        scale = psr.get("scale")
        if isinstance(scale, dict):
            values = [scale.get(axis) for axis in REQUIRED_VECTOR_FIELDS]
            if all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in values):
                if any(float(value) <= 0 for value in values):
                    warnings.append(f"{prefix}.psr.scale contains non-positive dimensions")

    return {"errors": errors, "warnings": warnings}


def save_labels(path: Path, labels: list[dict[str, Any]], known_classes: set[str]) -> dict[str, Any]:
    validation = validate_labels(labels, known_classes)
    if validation["errors"]:
        raise ValueError("; ".join(validation["errors"]))

    path.parent.mkdir(parents=True, exist_ok=True)
    backup_path = path.with_name(path.name + ".bak")
    had_existing = path.exists()
    if had_existing:
        shutil.copy2(path, backup_path)

    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(labels, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    return {"warnings": validation["warnings"], "backup_file": backup_path.name if had_existing else None}
