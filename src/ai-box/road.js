function key2d(x, y) {
    return `${x},${y}`;
}

function meanAndStd(values) {
    if (values.length === 0) {
        return { mean: 0, std: 0 };
    }
    let mean = 0;
    let m2 = 0;
    for (let index = 0; index < values.length; index += 1) {
        const delta = values[index] - mean;
        mean += delta / (index + 1);
        m2 += delta * (values[index] - mean);
    }
    return { mean, std: Math.sqrt(m2 / values.length) };
}

function buildPointGrid(points, cellSize) {
    const grid = new Map();
    for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        const ix = Math.floor(point[0] / cellSize);
        const iy = Math.floor(point[1] / cellSize);
        const key = key2d(ix, iy);
        let bucket = grid.get(key);
        if (!bucket) {
            bucket = [];
            grid.set(key, bucket);
        }
        bucket.push(index);
    }
    return grid;
}

function kNearestDistances(points, grid, cellSize, pointIndex, count) {
    if (points.length <= 1 || count <= 0) {
        return [];
    }
    const point = points[pointIndex];
    const originX = Math.floor(point[0] / cellSize);
    const originY = Math.floor(point[1] / cellSize);
    const candidates = [];
    const desired = Math.min(count, points.length - 1);
    const maximumRing = Math.max(2, Math.ceil(Math.sqrt(points.length)) + 1);
    let enoughAtRing = -1;

    for (let ring = 0; ring <= maximumRing; ring += 1) {
        for (let dx = -ring; dx <= ring; dx += 1) {
            for (let dy = -ring; dy <= ring; dy += 1) {
                if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) {
                    continue;
                }
                const bucket = grid.get(key2d(originX + dx, originY + dy));
                if (!bucket) {
                    continue;
                }
                for (const candidateIndex of bucket) {
                    if (candidateIndex === pointIndex) {
                        continue;
                    }
                    const candidate = points[candidateIndex];
                    const deltaX = candidate[0] - point[0];
                    const deltaY = candidate[1] - point[1];
                    candidates.push(Math.hypot(deltaX, deltaY));
                }
            }
        }

        if (candidates.length >= desired && enoughAtRing < 0) {
            // Search one additional ring to handle points close to a cell edge.
            enoughAtRing = ring;
        } else if (enoughAtRing >= 0 && ring > enoughAtRing) {
            break;
        }
    }

    candidates.sort((left, right) => left - right);
    return candidates.slice(0, desired);
}

function filterRoadOutliers(points, config) {
    const neighborCount = Math.min(config.roadOutlierK, points.length - 1);
    if (neighborCount <= 0) {
        return points;
    }

    const grid = buildPointGrid(points, config.roadGridSize);
    const averageDistances = points.map((_, index) => {
        const distances = kNearestDistances(
            points,
            grid,
            config.roadGridSize,
            index,
            neighborCount,
        );
        return distances.length > 0
            ? distances.reduce((sum, distance) => sum + distance, 0) / distances.length
            : Infinity;
    });
    const finiteDistances = averageDistances.filter(Number.isFinite);
    const stats = meanAndStd(finiteDistances);
    const threshold = stats.mean + config.roadOutlierStdMul * stats.std;
    const filtered = points.filter((_, index) => averageDistances[index] <= threshold);
    return filtered.length > 0 ? filtered : points;
}

function hasExcessiveSlope(point, pointIndex, points, grid, cellSize, radius, maxSlopeRadians) {
    if (radius <= 0) {
        return false;
    }
    const originX = Math.floor(point[0] / cellSize);
    const originY = Math.floor(point[1] / cellSize);
    const cellRadius = Math.ceil(radius / cellSize);
    const radiusSquared = radius * radius;

    for (let dx = -cellRadius; dx <= cellRadius; dx += 1) {
        for (let dy = -cellRadius; dy <= cellRadius; dy += 1) {
            const bucket = grid.get(key2d(originX + dx, originY + dy));
            if (!bucket) {
                continue;
            }
            for (const neighborIndex of bucket) {
                if (neighborIndex === pointIndex) {
                    continue;
                }
                const neighbor = points[neighborIndex];
                const deltaX = point[0] - neighbor[0];
                const deltaY = point[1] - neighbor[1];
                const horizontalSquared = deltaX * deltaX + deltaY * deltaY;
                if (horizontalSquared <= 1e-12 || horizontalSquared > radiusSquared || neighbor[2] >= point[2]) {
                    continue;
                }
                const angle = Math.atan2(point[2] - neighbor[2], Math.sqrt(horizontalSquared));
                if (angle > maxSlopeRadians) {
                    return true;
                }
            }
        }
    }
    return false;
}

function filterRoadSlopes(points, config) {
    if (points.length <= 1 || config.roadSlopeSearchMul <= 0 || config.roadMaxSlopeDeg >= 90) {
        return points;
    }
    const grid = buildPointGrid(points, config.roadGridSize);
    const radius = config.roadGridSize * config.roadSlopeSearchMul;
    const maxSlopeRadians = config.roadMaxSlopeDeg * Math.PI / 180;
    const filtered = points.filter((point, index) => !hasExcessiveSlope(
        point,
        index,
        points,
        grid,
        config.roadGridSize,
        radius,
        maxSlopeRadians,
    ));
    return filtered.length > 0 ? filtered : points;
}

/** Estimates one low road sample per XY cell and builds a nearest-point index. */
function extractRoad(points, config) {
    if (!points || points.length < 3) {
        return { points: [], grid: new Map(), cellSize: config.roadGridSize };
    }

    const zValues = [];
    const cells = new Map();
    for (let offset = 0; offset + 2 < points.length; offset += 3) {
        const x = points[offset];
        const y = points[offset + 1];
        const z = points[offset + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            continue;
        }
        zValues.push(z);
        const ix = Math.floor(x / config.roadGridSize);
        const iy = Math.floor(y / config.roadGridSize);
        const key = key2d(ix, iy);
        const cell = cells.get(key);
        if (!cell || z < cell.z) {
            cells.set(key, { x, y, z, sumX: 0, sumY: 0, nearLowestCount: 0 });
        }
    }

    if (zValues.length === 0) {
        return { points: [], grid: new Map(), cellSize: config.roadGridSize };
    }

    // Average the XY location of near-lowest samples while retaining the true
    // minimum Z. This uses roadCellLowestMargin without lifting the road plane.
    for (let offset = 0; offset + 2 < points.length; offset += 3) {
        const x = points[offset];
        const y = points[offset + 1];
        const z = points[offset + 2];
        const cell = cells.get(key2d(
            Math.floor(x / config.roadGridSize),
            Math.floor(y / config.roadGridSize),
        ));
        if (cell && z <= cell.z + config.roadCellLowestMargin) {
            cell.sumX += x;
            cell.sumY += y;
            cell.nearLowestCount += 1;
        }
    }

    const zStats = meanAndStd(zValues);
    const minimumZ = zStats.mean - config.roadZStatSigmaLow * zStats.std;
    const maximumZ = zStats.mean + config.roadZStatSigmaHigh * zStats.std;
    let roadPoints = [];
    for (const cell of cells.values()) {
        // Keep a perfectly flat frame (std === 0); an exclusive upper bound
        // would otherwise discard every road sample.
        if (cell.z < minimumZ || cell.z > maximumZ) {
            continue;
        }
        const count = Math.max(1, cell.nearLowestCount);
        roadPoints.push([
            cell.nearLowestCount > 0 ? cell.sumX / count : cell.x,
            cell.nearLowestCount > 0 ? cell.sumY / count : cell.y,
            cell.z,
        ]);
    }

    roadPoints = filterRoadOutliers(roadPoints, config);
    roadPoints = filterRoadSlopes(roadPoints, config);
    return {
        points: roadPoints,
        grid: buildPointGrid(roadPoints, config.roadGridSize),
        cellSize: config.roadGridSize,
    };
}

function queryRoadZ(roadModel, x, y, zOffset = 0) {
    if (!roadModel || !roadModel.points || roadModel.points.length === 0) {
        return null;
    }
    const pseudoPoint = [x, y, 0];
    const points = roadModel.points;
    const originX = Math.floor(x / roadModel.cellSize);
    const originY = Math.floor(y / roadModel.cellSize);
    let bestPoint = null;
    let bestDistanceSquared = Infinity;
    const maximumRing = Math.max(2, Math.ceil(Math.sqrt(points.length)) + 1);
    let foundRing = -1;

    for (let ring = 0; ring <= maximumRing; ring += 1) {
        for (let dx = -ring; dx <= ring; dx += 1) {
            for (let dy = -ring; dy <= ring; dy += 1) {
                if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) {
                    continue;
                }
                const bucket = roadModel.grid.get(key2d(originX + dx, originY + dy));
                if (!bucket) {
                    continue;
                }
                for (const index of bucket) {
                    const point = points[index];
                    const deltaX = point[0] - pseudoPoint[0];
                    const deltaY = point[1] - pseudoPoint[1];
                    const distanceSquared = deltaX * deltaX + deltaY * deltaY;
                    if (distanceSquared < bestDistanceSquared) {
                        bestDistanceSquared = distanceSquared;
                        bestPoint = point;
                    }
                }
            }
        }
        if (bestPoint && foundRing < 0) {
            foundRing = ring;
        } else if (foundRing >= 0 && ring > foundRing) {
            break;
        }
    }

    return bestPoint ? bestPoint[2] + zOffset : null;
}

export { extractRoad, queryRoadZ };
