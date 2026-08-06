/**
 * Crops interleaved LiDAR XYZ points with an NDC rectangle. The matrix is a
 * Three.js-compatible column-major local-LiDAR -> clip-space matrix.
 */
function subPcFromProjectRect(points, projectRect, viewProjMatrix, heightRange) {
    if (!points || points.length < 3 || !projectRect || !viewProjMatrix || viewProjMatrix.length !== 16) {
        return new Float32Array();
    }

    const minX = Math.min(projectRect[0].x, projectRect[1].x);
    const maxX = Math.max(projectRect[0].x, projectRect[1].x);
    const minY = Math.min(projectRect[0].y, projectRect[1].y);
    const maxY = Math.max(projectRect[0].y, projectRect[1].y);
    const minZ = heightRange[0];
    const maxZ = heightRange[1];
    const matrix = viewProjMatrix;
    const selected = [];

    for (let index = 0; index + 2 < points.length; index += 3) {
        const x = points[index];
        const y = points[index + 1];
        const z = points[index + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || z < minZ || z > maxZ) {
            continue;
        }

        const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
        const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
        const clipZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
        const clipW = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];

        if (!Number.isFinite(clipW) || clipW <= 0) {
            continue;
        }

        const ndcX = clipX / clipW;
        const ndcY = clipY / clipW;
        const ndcZ = clipZ / clipW;
        if (ndcZ < -1 || ndcZ > 1) {
            continue;
        }

        if (ndcX >= minX && ndcX <= maxX && ndcY >= minY && ndcY <= maxY) {
            selected.push(x, y, z);
        }
    }

    return new Float32Array(selected);
}

export { subPcFromProjectRect };
