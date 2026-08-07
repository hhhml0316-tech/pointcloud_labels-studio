from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import AppConfig
from .indexer import index_config
from .labels import load_labels, save_labels, validate_labels
from .models import SequenceRecord

# On Windows, mimetypes reads file associations from the registry, and clean
# machines often lack a .js entry. StaticFiles then falls back to
# "text/plain", and browsers refuse to execute module scripts served with the
# wrong MIME type. Register web asset types explicitly so static serving
# never depends on OS-level file associations.
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/wasm", ".wasm")


def create_app(config: AppConfig) -> FastAPI:
    app = FastAPI(title="PointCloud Labels Studio", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(config.cors_origins),
        allow_credentials=False,
        allow_methods=["GET", "PUT", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

    records = index_config(config)
    class_map = {str(item["id"]): item for item in config.classes}

    def get_record(sequence_id: str) -> SequenceRecord:
        record = records.get(sequence_id)
        if record is None:
            raise HTTPException(status_code=404, detail=f"unknown sequence: {sequence_id}")
        return record

    def get_frame(sequence_id: str, frame_id: str) -> tuple[SequenceRecord, Any]:
        record = get_record(sequence_id)
        try:
            return record, record.frame(frame_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"unknown frame: {frame_id}") from exc

    def point_path(record: SequenceRecord, frame: Any) -> Path:
        path = record.lidar_dir / frame.point_file
        if not path.is_file():
            raise HTTPException(status_code=404, detail="point file is missing")
        return path

    def label_path(record: SequenceRecord, frame: Any, for_write: bool = False) -> Path | None:
        if record.label_dir is None:
            if for_write:
                # For a lidar-only sequence, use the conventional sibling
                # directory on first save while keeping reads label-free.
                return record.lidar_dir.parent / "label" / f"{frame.frame_id}.json"
            return None
        return record.label_dir / f"{frame.frame_id}.json"

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"status": "ok", "sequences": len(records), "cuda_required": False}

    @app.get("/api/config/classes")
    def classes() -> list[dict[str, Any]]:
        return list(config.classes)

    @app.get("/api/config/ai-box")
    def ai_box_config() -> dict[str, Any]:
        return config.ai_box

    @app.get("/api/sequences")
    def sequences() -> list[dict[str, Any]]:
        return [record.info.as_dict() for record in records.values()]

    @app.get("/api/sequences/{sequence_id}/frames")
    def frames(sequence_id: str) -> list[dict[str, Any]]:
        return [frame.as_dict() for frame in get_record(sequence_id).frames]

    @app.get("/api/sequences/{sequence_id}/frames/{frame_id}/points")
    def points(sequence_id: str, frame_id: str) -> FileResponse:
        record, frame = get_frame(sequence_id, frame_id)
        return FileResponse(point_path(record, frame), media_type="application/octet-stream", filename=frame.point_file)

    @app.get("/api/sequences/{sequence_id}/frames/{frame_id}/labels")
    def labels(sequence_id: str, frame_id: str) -> dict[str, Any]:
        record, frame = get_frame(sequence_id, frame_id)
        path = label_path(record, frame)
        try:
            value = load_labels(path)
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        validation = validate_labels(value, set(class_map))
        return {"frame_id": frame_id, "boxes": value, "warnings": validation["warnings"], "label_exists": bool(path and path.is_file())}

    @app.put("/api/sequences/{sequence_id}/frames/{frame_id}/labels")
    async def put_labels(sequence_id: str, frame_id: str, request: Request) -> dict[str, Any]:
        record, frame = get_frame(sequence_id, frame_id)
        path = label_path(record, frame, for_write=True)
        assert path is not None
        try:
            body = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="request body must be JSON") from exc
        boxes = body.get("boxes") if isinstance(body, dict) else body
        if not isinstance(boxes, list):
            raise HTTPException(status_code=422, detail="request body must contain boxes array")
        try:
            result = save_labels(path, boxes, set(class_map))
        except (OSError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"status": "saved", "sequence_id": sequence_id, "frame_id": frame_id, **result}

    def existing_label_file(record: SequenceRecord, frame: Any) -> Path | None:
        # Mirror label_path(): configured label_dir wins; lidar-only sequences
        # fall back to the conventional sibling directory used on first save.
        if record.label_dir is not None:
            path = record.label_dir / f"{frame.frame_id}.json"
        else:
            path = record.lidar_dir.parent / "label" / f"{frame.frame_id}.json"
        return path if path.is_file() else None

    @app.post("/api/sequences/{sequence_id}/remap-track-id")
    async def remap_track_id(sequence_id: str, request: Request) -> dict[str, Any]:
        record = get_record(sequence_id)
        try:
            body = await request.json()
        except Exception as exc:
            raise HTTPException(status_code=400, detail="request body must be JSON") from exc
        if not isinstance(body, dict):
            raise HTTPException(status_code=422, detail="request body must be an object")
        from_id = body.get("from_id")
        to_id = body.get("to_id")
        from_key = str(from_id).strip() if from_id is not None else ""
        to_key = str(to_id).strip() if to_id is not None else ""
        if not from_key or not to_key:
            raise HTTPException(status_code=422, detail="from_id and to_id are required")
        if from_key == to_key:
            raise HTTPException(status_code=422, detail="from_id and to_id must differ")

        updated_frames: list[str] = []
        skipped_frames: list[dict[str, str]] = []
        for frame in record.frames:
            path = existing_label_file(record, frame)
            if path is None:
                continue
            try:
                boxes = load_labels(path)
            except (OSError, ValueError) as exc:
                skipped_frames.append({"frame_id": frame.frame_id, "reason": f"标签读取失败：{exc}"})
                continue
            if not any(isinstance(box, dict) and str(box.get("obj_id")) == from_key for box in boxes):
                continue
            if any(isinstance(box, dict) and str(box.get("obj_id")) == to_key for box in boxes):
                skipped_frames.append(
                    {
                        "frame_id": frame.frame_id,
                        "reason": f"同一帧已存在 ID {to_key}，为避免把两个框合并成一个 ID 而跳过",
                    }
                )
                continue
            for box in boxes:
                if isinstance(box, dict) and str(box.get("obj_id")) == from_key:
                    # Preserve numeric JSON typing when both sides are numeric.
                    box["obj_id"] = int(to_key) if isinstance(box.get("obj_id"), int) and to_key.isdigit() else to_key
            try:
                save_labels(path, boxes, set(class_map))
            except (OSError, ValueError) as exc:
                skipped_frames.append({"frame_id": frame.frame_id, "reason": f"标签保存失败：{exc}"})
                continue
            updated_frames.append(frame.frame_id)
        return {
            "status": "ok",
            "sequence_id": sequence_id,
            "from_id": from_key,
            "to_id": to_key,
            "updated_frames": updated_frames,
            "skipped_frames": skipped_frames,
        }

    # A production build can be served by the same local process. During
    # development Vite serves the frontend and proxies /api to this app.
    dist_dir = Path(__file__).resolve().parent.parent / "dist"
    if dist_dir.is_dir():
        app.mount("/", StaticFiles(directory=dist_dir, html=True), name="frontend")

    return app
