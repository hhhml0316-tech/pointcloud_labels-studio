import type { AIBoxConfig, AIBoxFitResult } from '../types'

export type AIBoxFitInput = {
  frameId: string
  projectRect: [{ x: number; y: number }, { x: number; y: number }]
  viewProjMatrix: number[]
  headAngle: number
  config?: Partial<AIBoxConfig>
}

export class AIBoxFitter {
  constructor(configProvider?: (() => Partial<AIBoxConfig>) | null)
  setFrame(frameId: string, points: Float32Array, groundCacheKey?: string | null): void
  initAIBox(
    frameId: string,
    points: Float32Array,
    override?: Partial<AIBoxConfig> | null,
    groundCacheKey?: string | null,
  ): Promise<unknown>
  fitAIBox(input: AIBoxFitInput): Promise<AIBoxFitResult | null>
  resetAIBox(): void
}
