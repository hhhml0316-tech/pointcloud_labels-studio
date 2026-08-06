import { createAIBoxConfig } from "./config.js";
import { subPcFromProjectRect } from "./crop.js";
import { fitBox3dFromSubpc } from "./fit.js";
import { extractRoad } from "./road.js";

let currentFrameId = null;
let framePoints = null;
let roadModel = null;
let frameConfig = null;
let groundCacheKey = null;
let groundSignature = null;

self.onmessage = (event) => {
    const { id, type } = event.data;
    try {
        if (type === "init") {
            currentFrameId = event.data.frameId;
            framePoints = event.data.points;
            frameConfig = createAIBoxConfig(event.data.config);
            const reuseGround = Boolean(
                roadModel
                && groundCacheKey === event.data.groundCacheKey
                && groundSignature === event.data.groundSignature
            );
            if (!reuseGround) {
                roadModel = extractRoad(framePoints, frameConfig);
                groundCacheKey = event.data.groundCacheKey;
                groundSignature = event.data.groundSignature;
            }
            self.postMessage({
                id,
                frameId: currentFrameId,
                result: { roadPointCount: roadModel.points.length, reusedGround: reuseGround },
            });
            return;
        }

        if (type === "fit") {
            const config = createAIBoxConfig(event.data.config || frameConfig);
            if (!framePoints || event.data.frameId !== currentFrameId) {
                self.postMessage({ id, frameId: currentFrameId, result: null });
                return;
            }
            const subpc = subPcFromProjectRect(
                framePoints,
                event.data.projectRect,
                event.data.viewProjMatrix,
                config.heightRange,
            );
            const result = fitBox3dFromSubpc(subpc, roadModel, event.data.headAngle, config);
            self.postMessage({ id, frameId: currentFrameId, result });
            return;
        }

        if (type === "reset") {
            currentFrameId = null;
            framePoints = null;
            roadModel = null;
            frameConfig = null;
            groundCacheKey = null;
            groundSignature = null;
            self.postMessage({ id, result: true });
            return;
        }

        throw new Error(`Unsupported AI-box worker message: ${type}`);
    } catch (error) {
        self.postMessage({
            id,
            frameId: currentFrameId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
};
