function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Projects homogeneous LiDAR-space box corners to a padded NDC rectangle.
 * `matrix` uses the same column-major layout as THREE.Matrix4.elements.
 */
function projectCornersToRect(corners, matrix, paddingRatio = 0) {
    if (!corners || corners.length < 4 || !matrix || matrix.length !== 16) {
        return null;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let visibleCornerCount = 0;

    for (let offset = 0; offset + 3 < corners.length; offset += 4) {
        const x = corners[offset];
        const y = corners[offset + 1];
        const z = corners[offset + 2];
        const w = corners[offset + 3];
        const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12] * w;
        const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13] * w;
        const clipW = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15] * w;
        if (!Number.isFinite(clipW) || clipW <= 1e-8) {
            continue;
        }

        const ndcX = clipX / clipW;
        const ndcY = clipY / clipW;
        if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) {
            continue;
        }
        minX = Math.min(minX, ndcX);
        maxX = Math.max(maxX, ndcX);
        minY = Math.min(minY, ndcY);
        maxY = Math.max(maxY, ndcY);
        visibleCornerCount += 1;
    }

    if (visibleCornerCount < 2) {
        return null;
    }

    const ratio = Math.max(0, Number(paddingRatio) || 0);
    const paddingX = Math.max(0.005, (maxX - minX) * ratio);
    const paddingY = Math.max(0.005, (maxY - minY) * ratio);
    minX = clamp(minX - paddingX, -1, 1);
    maxX = clamp(maxX + paddingX, -1, 1);
    minY = clamp(minY - paddingY, -1, 1);
    maxY = clamp(maxY + paddingY, -1, 1);

    if (maxX <= minX || maxY <= minY) {
        return null;
    }
    return [{ x: minX, y: minY }, { x: maxX, y: maxY }];
}

export { projectCornersToRect };
