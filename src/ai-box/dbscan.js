function bucketKey(x, y, z) {
    return `${x},${y},${z}`;
}

function buildBuckets(points, cellSize) {
    const buckets = new Map();
    const pointCount = Math.floor(points.length / 3);
    for (let index = 0; index < pointCount; index += 1) {
        const offset = index * 3;
        const ix = Math.floor(points[offset] / cellSize);
        const iy = Math.floor(points[offset + 1] / cellSize);
        const iz = Math.floor(points[offset + 2] / cellSize);
        const key = bucketKey(ix, iy, iz);
        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = [];
            buckets.set(key, bucket);
        }
        bucket.push(index);
    }
    return buckets;
}

function dbscanLargestCluster(points, eps, minPts) {
    const pointCount = Math.floor(points.length / 3);
    if (pointCount === 0) {
        return new Float32Array();
    }

    const buckets = buildBuckets(points, eps);
    const labels = new Int32Array(pointCount);
    labels.fill(-2); // -2 = unvisited, -1 = noise
    const epsSquared = eps * eps;

    const regionQuery = (pointIndex) => {
        const offset = pointIndex * 3;
        const x = points[offset];
        const y = points[offset + 1];
        const z = points[offset + 2];
        const ix = Math.floor(x / eps);
        const iy = Math.floor(y / eps);
        const iz = Math.floor(z / eps);
        const neighbors = [];

        for (let dx = -1; dx <= 1; dx += 1) {
            for (let dy = -1; dy <= 1; dy += 1) {
                for (let dz = -1; dz <= 1; dz += 1) {
                    const bucket = buckets.get(bucketKey(ix + dx, iy + dy, iz + dz));
                    if (!bucket) {
                        continue;
                    }
                    for (const candidate of bucket) {
                        const candidateOffset = candidate * 3;
                        const deltaX = points[candidateOffset] - x;
                        const deltaY = points[candidateOffset + 1] - y;
                        const deltaZ = points[candidateOffset + 2] - z;
                        if (deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ <= epsSquared) {
                            neighbors.push(candidate);
                        }
                    }
                }
            }
        }
        return neighbors;
    };

    const clusterSizes = [];
    let clusterId = 0;
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
        if (labels[pointIndex] !== -2) {
            continue;
        }

        const initialNeighbors = regionQuery(pointIndex);
        if (initialNeighbors.length < minPts) {
            labels[pointIndex] = -1;
            continue;
        }

        labels[pointIndex] = clusterId;
        let clusterSize = 1;
        const queue = initialNeighbors.slice();
        const queued = new Uint8Array(pointCount);
        for (const neighbor of initialNeighbors) {
            queued[neighbor] = 1;
        }

        for (let cursor = 0; cursor < queue.length; cursor += 1) {
            const neighbor = queue[cursor];
            if (labels[neighbor] === -1) {
                labels[neighbor] = clusterId;
                clusterSize += 1;
            }
            if (labels[neighbor] !== -2) {
                continue;
            }

            labels[neighbor] = clusterId;
            clusterSize += 1;
            const expanded = regionQuery(neighbor);
            if (expanded.length >= minPts) {
                for (const expandedNeighbor of expanded) {
                    if (!queued[expandedNeighbor]) {
                        queued[expandedNeighbor] = 1;
                        queue.push(expandedNeighbor);
                    }
                }
            }
        }

        clusterSizes.push(clusterSize);
        clusterId += 1;
    }

    if (clusterSizes.length === 0) {
        return new Float32Array();
    }

    let largestId = 0;
    for (let index = 1; index < clusterSizes.length; index += 1) {
        if (clusterSizes[index] > clusterSizes[largestId]) {
            largestId = index;
        }
    }

    const cluster = new Float32Array(clusterSizes[largestId] * 3);
    let writeOffset = 0;
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
        if (labels[pointIndex] !== largestId) {
            continue;
        }
        const offset = pointIndex * 3;
        cluster[writeOffset] = points[offset];
        cluster[writeOffset + 1] = points[offset + 1];
        cluster[writeOffset + 2] = points[offset + 2];
        writeOffset += 3;
    }

    return cluster;
}

export { dbscanLargestCluster };
