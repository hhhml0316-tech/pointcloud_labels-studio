import { dbscanLargestCluster } from "./dbscan.js";
import { bestBoundingBox2d, normalizeAngle } from "./oriented-bbox.js";
import { queryRoadZ } from "./road.js";

function pointCount(points) {
    return Math.floor(points.length / 3);
}

function bounds3d(points) {
    if (!points || points.length < 3) {
        return null;
    }
    const bounds = {
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity,
        minZ: Infinity,
        maxZ: -Infinity,
    };
    for (let offset = 0; offset + 2 < points.length; offset += 3) {
        bounds.minX = Math.min(bounds.minX, points[offset]);
        bounds.maxX = Math.max(bounds.maxX, points[offset]);
        bounds.minY = Math.min(bounds.minY, points[offset + 1]);
        bounds.maxY = Math.max(bounds.maxY, points[offset + 1]);
        bounds.minZ = Math.min(bounds.minZ, points[offset + 2]);
        bounds.maxZ = Math.max(bounds.maxZ, points[offset + 2]);
    }
    return bounds;
}

function filterAboveRoad(points, roadZ) {
    if (!Number.isFinite(roadZ)) {
        return new Float32Array(points);
    }
    const filtered = [];
    for (let offset = 0; offset + 2 < points.length; offset += 3) {
        if (points[offset + 2] >= roadZ) {
            filtered.push(points[offset], points[offset + 1], points[offset + 2]);
        }
    }
    return new Float32Array(filtered);
}

function uniformlyDownsample(points, maximumPoints) {
    const count = pointCount(points);
    if (!maximumPoints || count <= maximumPoints) {
        return points;
    }
    const sampled = new Float32Array(maximumPoints * 3);
    for (let index = 0; index < maximumPoints; index += 1) {
        const sourceIndex = maximumPoints === 1
            ? 0
            : Math.round(index * (count - 1) / (maximumPoints - 1));
        sampled[index * 3] = points[sourceIndex * 3];
        sampled[index * 3 + 1] = points[sourceIndex * 3 + 1];
        sampled[index * 3 + 2] = points[sourceIndex * 3 + 2];
    }
    return sampled;
}

function localRoadHeight(points, roadModel, config) {
    const bounds = bounds3d(points);
    if (!bounds || !roadModel || !roadModel.points || roadModel.points.length === 0) {
        return null;
    }
    const corners = [
        [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2],
        [bounds.minX, bounds.minY],
        [bounds.minX, bounds.maxY],
        [bounds.maxX, bounds.minY],
        [bounds.maxX, bounds.maxY],
    ];
    const heights = corners
        .map(([x, y]) => queryRoadZ(roadModel, x, y, config.roadQueryZOffset))
        .filter(Number.isFinite);
    if (heights.length === 0) {
        return null;
    }
    return Math.max(...heights);
}

function fittedFootprintRoadHeight(box2d, roadModel, config) {
    if (!box2d || !roadModel || !roadModel.points || roadModel.points.length === 0) {
        return null;
    }
    const cosine = Math.cos(box2d.angle);
    const sine = Math.sin(box2d.angle);
    const halfX = box2d.sizeX / 2;
    const halfY = box2d.sizeY / 2;
    const locations = [[box2d.centerX, box2d.centerY]];
    for (const localX of [-halfX, halfX]) {
        for (const localY of [-halfY, halfY]) {
            locations.push([
                box2d.centerX + cosine * localX - sine * localY,
                box2d.centerY + sine * localX + cosine * localY,
            ]);
        }
    }
    const heights = locations
        .map(([x, y]) => queryRoadZ(roadModel, x, y, config.roadQueryZOffset))
        .filter(Number.isFinite);
    return heights.length > 0 ? Math.max(...heights) : null;
}

function fitBox3dFromSubpc(subpc, roadModel, headAngle, config) {
    if (!subpc || pointCount(subpc) < config.minPointsAfterRoadFilter) {
        return null;
    }

    const selectionRoadZ = localRoadHeight(subpc, roadModel, config);
    let filtered = filterAboveRoad(
        subpc,
        Number.isFinite(selectionRoadZ) ? selectionRoadZ + config.roadGap : selectionRoadZ,
    );
    if (pointCount(filtered) < config.minPointsAfterRoadFilter) {
        return null;
    }

    if (config.enableDenoise && pointCount(filtered) > config.minFilterPoints) {
        const denoised = dbscanLargestCluster(filtered, config.dbscanEps, config.dbscanMinPts);
        if (pointCount(denoised) < config.minPointsAfterRoadFilter) {
            return null;
        }
        filtered = denoised;
    }

    const fullBounds = bounds3d(filtered);
    const fitPoints = uniformlyDownsample(filtered, config.maxPointsForFit);
    const box2d = bestBoundingBox2d(fitPoints, config);
    if (!box2d || !fullBounds) {
        return null;
    }

    let yaw = box2d.angle;
    if (config.useHeadAngle && Number.isFinite(headAngle)) {
        const delta = normalizeAngle(yaw - headAngle);
        if (Math.abs(delta) > config.headFlipThresholdRad) {
            yaw = normalizeAngle(yaw + Math.PI);
        }
    }

    const roadZ = fittedFootprintRoadHeight(box2d, roadModel, config) ?? selectionRoadZ;
    // The fitted box is grounded explicitly: its lower face follows the local
    // road estimate instead of being inferred from the lowest object return.
    // Never lift the lower face above the retained cluster's lowest point.
    const groundBottom = Number.isFinite(roadZ) ? roadZ + config.roadGap : fullBounds.minZ;
    const bottomZ = Math.min(fullBounds.minZ, groundBottom);
    const topZ = Math.max(fullBounds.maxZ, bottomZ + config.minBoxSize);
    const height = topZ - bottomZ;
    return {
        position: {
            x: box2d.centerX,
            y: box2d.centerY,
            z: (bottomZ + topZ) / 2,
        },
        scale: {
            x: Math.max(config.minBoxSize, box2d.sizeX),
            y: Math.max(config.minBoxSize, box2d.sizeY),
            z: Math.max(config.minBoxSize, height),
        },
        rotation: { x: 0, y: 0, z: yaw },
        diagnostics: {
            inputPointCount: pointCount(subpc),
            fittedPointCount: pointCount(fitPoints),
            roadZ,
            loss: box2d.loss,
        },
    };
}

export { fitBox3dFromSubpc, uniformlyDownsample };
