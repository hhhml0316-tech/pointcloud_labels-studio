function normalizeAngle(angle) {
    let normalized = angle;
    while (normalized <= -Math.PI) {
        normalized += Math.PI * 2;
    }
    while (normalized > Math.PI) {
        normalized -= Math.PI * 2;
    }
    return normalized;
}

function evaluateAngle(points, angle, edgeGap, lossScale) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const pointCount = Math.floor(points.length / 3);

    for (let index = 0; index < pointCount; index += 1) {
        const offset = index * 3;
        const x = points[offset];
        const y = points[offset + 1];
        const localX = cosine * x + sine * y;
        const localY = -sine * x + cosine * y;
        minX = Math.min(minX, localX);
        maxX = Math.max(maxX, localX);
        minY = Math.min(minY, localY);
        maxY = Math.max(maxY, localY);
    }

    const sideDistances = [[], [], [], []];
    for (let index = 0; index < pointCount; index += 1) {
        const offset = index * 3;
        const x = points[offset];
        const y = points[offset + 1];
        const localX = cosine * x + sine * y;
        const localY = -sine * x + cosine * y;
        const distances = [
            localX - minX,
            maxX - localX,
            localY - minY,
            maxY - localY,
        ];
        for (let side = 0; side < distances.length; side += 1) {
            if (distances[side] <= edgeGap) {
                sideDistances[side].push(distances[side]);
            }
        }
    }

    let weightedDeviation = 0;
    let validCount = 0;
    for (const distances of sideDistances) {
        if (distances.length === 0) {
            continue;
        }
        const mean = distances.reduce((sum, distance) => sum + distance, 0) / distances.length;
        const variance = distances.reduce((sum, distance) => {
            const delta = distance - mean;
            return sum + delta * delta;
        }, 0) / distances.length;
        weightedDeviation += Math.sqrt(variance) * distances.length;
        validCount += distances.length;
    }

    const loss = validCount > 0
        ? weightedDeviation / validCount / validCount * lossScale
        : Infinity;
    return {
        angle,
        loss,
        minX,
        maxX,
        minY,
        maxY,
        validCount,
    };
}

function linearAngles(start, end, count, excludeEndpoints = false) {
    if (count <= 1) {
        return [(start + end) / 2];
    }
    const divisor = excludeEndpoints ? count + 1 : count - 1;
    const angles = [];
    for (let index = 0; index < count; index += 1) {
        const position = excludeEndpoints ? index + 1 : index;
        angles.push(start + (end - start) * position / divisor);
    }
    return angles;
}

function searchRound(points, angles, config) {
    let best = null;
    for (const angle of angles) {
        const candidate = evaluateAngle(points, angle, config.edgeGap, config.lossScale);
        if (!best || candidate.loss < best.loss || (
            candidate.loss === best.loss
            && (candidate.maxX - candidate.minX) * (candidate.maxY - candidate.minY)
                < (best.maxX - best.minX) * (best.maxY - best.minY)
        )) {
            best = candidate;
        }
    }
    return best;
}

function bestBoundingBox2d(points, config) {
    if (!points || points.length < 3) {
        return null;
    }

    const firstAngles = linearAngles(0, Math.PI / 2, config.angleSearch.round1Count);
    let best = searchRound(points, firstAngles, config);
    let searchStep = firstAngles.length > 1 ? firstAngles[1] - firstAngles[0] : Math.PI / 2;

    const secondAngles = linearAngles(
        best.angle - searchStep,
        best.angle + searchStep,
        config.angleSearch.round2Count,
        true,
    );
    best = searchRound(points, secondAngles.concat([best.angle]), config);
    searchStep = searchStep * 2 / (config.angleSearch.round2Count + 1);

    const thirdAngles = linearAngles(
        best.angle - searchStep,
        best.angle + searchStep,
        config.angleSearch.round3Count,
        true,
    );
    best = searchRound(points, thirdAngles.concat([best.angle]), config);

    let angle = best.angle;
    let sizeX = best.maxX - best.minX;
    let sizeY = best.maxY - best.minY;
    let centerLocalX = (best.minX + best.maxX) / 2;
    let centerLocalY = (best.minY + best.maxY) / 2;

    if (config.preferLongEdgeAsX && sizeX < sizeY) {
        [sizeX, sizeY] = [sizeY, sizeX];
        angle += Math.PI / 2;
        [centerLocalX, centerLocalY] = [centerLocalY, -centerLocalX];
    }

    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return {
        centerX: cosine * centerLocalX - sine * centerLocalY,
        centerY: sine * centerLocalX + cosine * centerLocalY,
        sizeX,
        sizeY,
        angle: normalizeAngle(angle),
        loss: best.loss,
    };
}

export { bestBoundingBox2d, normalizeAngle };
