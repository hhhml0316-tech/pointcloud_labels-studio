const DEFAULT_AI_BOX_CONFIG = Object.freeze({
    // Keep playback/rendering as the default priority. Users can enable the
    // fitter from the main toolbar when they need an AI-assisted box.
    enabled: false,
    minBoxSize: 0.2,
    heightRange: Object.freeze([-10000, 10000]),

    roadGridSize: 2.0,
    roadZStatSigmaLow: 2,
    roadZStatSigmaHigh: 1,
    roadCellLowestMargin: 0.5,
    roadOutlierK: 10,
    roadOutlierStdMul: 0,
    roadMaxSlopeDeg: 5,
    roadSlopeSearchMul: 20,
    roadQueryZOffset: 0.1,

    roadGap: 0.1,
    minPointsAfterRoadFilter: 10,
    enableDenoise: true,
    minFilterPoints: 100,
    dbscanEps: 0.5,
    dbscanMinPts: 3,

    angleSearch: Object.freeze({
        round1Count: 10,
        round2Count: 11,
        round3Count: 9,
    }),
    edgeGap: 0.5,
    lossScale: 50,
    preferLongEdgeAsX: true,

    useHeadAngle: true,
    headFlipThresholdRad: Math.PI / 2,

    // Extra screen-space context used when re-fitting an existing box.
    existingBoxFitPaddingRatio: 0.2,

    useWorker: true,
});

function finiteNumber(value, fallback, minimum = -Infinity, maximum = Infinity) {
    const number = Number(value);
    return Number.isFinite(number)
        ? Math.min(maximum, Math.max(minimum, number))
        : fallback;
}

function integer(value, fallback, minimum = 1) {
    return Math.max(minimum, Math.round(finiteNumber(value, fallback, minimum)));
}

function bool(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
}

/**
 * Deep-merges and validates a partial AI-box configuration. Keeping this at
 * the module boundary prevents malformed localStorage values from reaching
 * the fitting loops.
 */
function createAIBoxConfig(partial = {}) {
    const source = partial && typeof partial === "object" ? partial : {};
    const angle = source.angleSearch && typeof source.angleSearch === "object"
        ? source.angleSearch
        : {};

    let heightRange = DEFAULT_AI_BOX_CONFIG.heightRange.slice();
    if (Array.isArray(source.heightRange) && source.heightRange.length >= 2) {
        const low = finiteNumber(source.heightRange[0], heightRange[0]);
        const high = finiteNumber(source.heightRange[1], heightRange[1]);
        heightRange = low <= high ? [low, high] : [high, low];
    }

    const config = {
        enabled: bool(source.enabled, DEFAULT_AI_BOX_CONFIG.enabled),
        minBoxSize: finiteNumber(source.minBoxSize, DEFAULT_AI_BOX_CONFIG.minBoxSize, 0.001),
        heightRange,

        roadGridSize: finiteNumber(source.roadGridSize, DEFAULT_AI_BOX_CONFIG.roadGridSize, 0.01),
        roadZStatSigmaLow: finiteNumber(source.roadZStatSigmaLow, DEFAULT_AI_BOX_CONFIG.roadZStatSigmaLow, 0),
        roadZStatSigmaHigh: finiteNumber(source.roadZStatSigmaHigh, DEFAULT_AI_BOX_CONFIG.roadZStatSigmaHigh, 0),
        roadCellLowestMargin: finiteNumber(source.roadCellLowestMargin, DEFAULT_AI_BOX_CONFIG.roadCellLowestMargin, 0),
        roadOutlierK: integer(source.roadOutlierK, DEFAULT_AI_BOX_CONFIG.roadOutlierK),
        roadOutlierStdMul: finiteNumber(source.roadOutlierStdMul, DEFAULT_AI_BOX_CONFIG.roadOutlierStdMul),
        roadMaxSlopeDeg: finiteNumber(source.roadMaxSlopeDeg, DEFAULT_AI_BOX_CONFIG.roadMaxSlopeDeg, 0, 90),
        roadSlopeSearchMul: finiteNumber(source.roadSlopeSearchMul, DEFAULT_AI_BOX_CONFIG.roadSlopeSearchMul, 0),
        roadQueryZOffset: finiteNumber(source.roadQueryZOffset, DEFAULT_AI_BOX_CONFIG.roadQueryZOffset),

        roadGap: finiteNumber(source.roadGap, DEFAULT_AI_BOX_CONFIG.roadGap, 0),
        minPointsAfterRoadFilter: integer(
            source.minPointsAfterRoadFilter,
            DEFAULT_AI_BOX_CONFIG.minPointsAfterRoadFilter,
        ),
        enableDenoise: bool(source.enableDenoise, DEFAULT_AI_BOX_CONFIG.enableDenoise),
        minFilterPoints: integer(source.minFilterPoints, DEFAULT_AI_BOX_CONFIG.minFilterPoints),
        dbscanEps: finiteNumber(source.dbscanEps, DEFAULT_AI_BOX_CONFIG.dbscanEps, 0.001),
        dbscanMinPts: integer(source.dbscanMinPts, DEFAULT_AI_BOX_CONFIG.dbscanMinPts),

        angleSearch: {
            round1Count: integer(angle.round1Count, DEFAULT_AI_BOX_CONFIG.angleSearch.round1Count, 2),
            round2Count: integer(angle.round2Count, DEFAULT_AI_BOX_CONFIG.angleSearch.round2Count, 1),
            round3Count: integer(angle.round3Count, DEFAULT_AI_BOX_CONFIG.angleSearch.round3Count, 1),
        },
        edgeGap: finiteNumber(source.edgeGap, DEFAULT_AI_BOX_CONFIG.edgeGap, 0.001),
        lossScale: finiteNumber(source.lossScale, DEFAULT_AI_BOX_CONFIG.lossScale, 0),
        preferLongEdgeAsX: bool(
            source.preferLongEdgeAsX,
            DEFAULT_AI_BOX_CONFIG.preferLongEdgeAsX,
        ),

        useHeadAngle: bool(source.useHeadAngle, DEFAULT_AI_BOX_CONFIG.useHeadAngle),
        headFlipThresholdRad: finiteNumber(
            source.headFlipThresholdRad,
            DEFAULT_AI_BOX_CONFIG.headFlipThresholdRad,
            0,
            Math.PI,
        ),

        existingBoxFitPaddingRatio: finiteNumber(
            source.existingBoxFitPaddingRatio,
            DEFAULT_AI_BOX_CONFIG.existingBoxFitPaddingRatio,
            0,
            5,
        ),

        useWorker: bool(source.useWorker, DEFAULT_AI_BOX_CONFIG.useWorker),
    };

    if (source.maxPointsForFit !== undefined && source.maxPointsForFit !== null && source.maxPointsForFit !== "") {
        config.maxPointsForFit = integer(
            source.maxPointsForFit,
            config.minPointsAfterRoadFilter,
            config.minPointsAfterRoadFilter,
        );
    }

    return config;
}

function roadConfigSignature(config) {
    const cfg = createAIBoxConfig(config);
    return JSON.stringify({
        roadGridSize: cfg.roadGridSize,
        roadZStatSigmaLow: cfg.roadZStatSigmaLow,
        roadZStatSigmaHigh: cfg.roadZStatSigmaHigh,
        roadCellLowestMargin: cfg.roadCellLowestMargin,
        roadOutlierK: cfg.roadOutlierK,
        roadOutlierStdMul: cfg.roadOutlierStdMul,
        roadMaxSlopeDeg: cfg.roadMaxSlopeDeg,
        roadSlopeSearchMul: cfg.roadSlopeSearchMul,
        roadQueryZOffset: cfg.roadQueryZOffset,
        useWorker: cfg.useWorker,
    });
}

export { DEFAULT_AI_BOX_CONFIG, createAIBoxConfig, roadConfigSignature };
