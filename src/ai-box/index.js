import { createAIBoxConfig, roadConfigSignature } from "./config.js";
import { subPcFromProjectRect } from "./crop.js";
import { fitBox3dFromSubpc } from "./fit.js";
import { extractRoad } from "./road.js";

class AIBoxFitter {
    constructor(configProvider = null) {
        this.configProvider = configProvider;
        this.worker = null;
        this.pending = new Map();
        this.nextRequestId = 1;
        this.frameId = null;
        this.sourcePoints = null;
        this.roadModel = null;
        this.groundCacheKey = null;
        this.groundSignature = null;
        this.initializedSignature = null;
        this.initialization = null;
    }

    getConfig(override = null) {
        const provided = this.configProvider ? this.configProvider() : null;
        const base = createAIBoxConfig(provided || {});
        if (!override) {
            return base;
        }
        return createAIBoxConfig({
            ...base,
            ...override,
            angleSearch: { ...base.angleSearch, ...(override.angleSearch || {}) },
        });
    }

    createWorker() {
        if (this.worker) {
            return this.worker;
        }
        this.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
        this.worker.onmessage = (event) => {
            const pending = this.pending.get(event.data.id);
            if (!pending) {
                return;
            }
            this.pending.delete(event.data.id);
            if (event.data.error) {
                pending.reject(new Error(event.data.error));
            } else {
                pending.resolve(event.data);
            }
        };
        this.worker.onerror = (event) => {
            const error = new Error(event.message || "AI-box worker failed");
            this.terminateWorker(error);
        };
        return this.worker;
    }

    terminateWorker(error = new Error("AI-box worker was terminated")) {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
    }

    postToWorker(type, payload, transfer = []) {
        const worker = this.createWorker();
        const id = this.nextRequestId;
        this.nextRequestId += 1;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            worker.postMessage({ id, type, ...payload }, transfer);
        });
    }

    resetAIBox() {
        this.terminateWorker(new Error("AI-box frame was reset"));
        this.frameId = null;
        this.sourcePoints = null;
        this.roadModel = null;
        this.groundCacheKey = null;
        this.groundSignature = null;
        this.initializedSignature = null;
        this.initialization = null;
    }

    /**
     * Updates the active frame without starting geometry work. Ground state is
     * retained while frames belong to the same sequence and invalidated when a
     * sequence/configuration boundary is crossed.
     */
    setFrame(frameId, points, groundCacheKey = null) {
        const nextGroundCacheKey = groundCacheKey || frameId;
        const canKeepGround = this.groundCacheKey === nextGroundCacheKey;
        if (!canKeepGround || this.pending.size > 0) {
            this.terminateWorker(new Error("AI-box frame changed"));
            this.roadModel = null;
            this.groundSignature = null;
        }
        this.frameId = frameId;
        this.sourcePoints = points;
        this.groundCacheKey = nextGroundCacheKey;
        this.initializedSignature = null;
        this.initialization = null;
    }

    async initializeCurrentFrame(config) {
        const signature = roadConfigSignature(config);
        if (this.initialization && this.initializedSignature === signature) {
            return this.initialization;
        }
        if (!this.sourcePoints || !this.frameId) {
            return null;
        }

        const frameId = this.frameId;
        const groundCacheKey = this.groundCacheKey;
        const sourcePoints = this.sourcePoints;
        this.initializedSignature = signature;
        if (config.useWorker && typeof Worker !== "undefined") {
            const copy = new Float32Array(sourcePoints);
            this.initialization = this.postToWorker("init", {
                frameId,
                points: copy,
                config,
                groundCacheKey,
                groundSignature: signature,
            }, [copy.buffer]).catch((error) => {
                if (this.frameId !== frameId || this.groundCacheKey !== groundCacheKey) {
                    throw error;
                }
                // A CSP/MIME/worker failure should not make box creation unusable.
                this.terminateWorker(error);
                this.roadModel = extractRoad(sourcePoints, config);
                this.groundSignature = signature;
                return { frameId, result: { fallback: true, error: error.message } };
            }).then((response) => {
                if (this.frameId === frameId && this.groundCacheKey === groundCacheKey) {
                    this.groundSignature = signature;
                }
                return response;
            });
        } else {
            this.initialization = Promise.resolve().then(() => {
                const reusedGround = Boolean(this.roadModel && this.groundSignature === signature);
                if (!reusedGround) {
                    this.roadModel = extractRoad(this.sourcePoints, config);
                    this.groundSignature = signature;
                }
                return { frameId, result: { roadPointCount: this.roadModel.points.length, reusedGround } };
            });
        }
        return this.initialization;
    }

    initAIBox(frameId, points, override = null, groundCacheKey = null) {
        this.setFrame(frameId, points, groundCacheKey);
        const config = this.getConfig(override);
        if (!config.enabled) {
            return Promise.resolve({ frameId, result: { skipped: true } });
        }
        return this.initializeCurrentFrame(config);
    }

    async fitAIBox(input) {
        const config = this.getConfig(input.config);
        if (!config.enabled || !this.sourcePoints || input.frameId !== this.frameId) {
            return null;
        }

        const expectedSignature = roadConfigSignature(config);
        if (this.initializedSignature !== expectedSignature) {
            await this.initializeCurrentFrame(config);
        } else {
            await this.initialization;
        }

        if (config.useWorker && this.worker) {
            const response = await this.postToWorker("fit", {
                frameId: input.frameId,
                projectRect: input.projectRect,
                viewProjMatrix: input.viewProjMatrix,
                headAngle: input.headAngle,
                config,
            });
            return response.frameId === input.frameId ? response.result : null;
        }

        if (!this.roadModel) {
            this.roadModel = extractRoad(this.sourcePoints, config);
        }
        const subpc = subPcFromProjectRect(
            this.sourcePoints,
            input.projectRect,
            input.viewProjMatrix,
            config.heightRange,
        );
        return fitBox3dFromSubpc(subpc, this.roadModel, input.headAngle, config);
    }
}

export { AIBoxFitter };
