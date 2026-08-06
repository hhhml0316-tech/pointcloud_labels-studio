import type { AIBoxConfig } from '../types'

export const DEFAULT_AI_BOX_CONFIG: Readonly<AIBoxConfig>
export function createAIBoxConfig(partial?: Partial<AIBoxConfig>): AIBoxConfig
export function roadConfigSignature(config: Partial<AIBoxConfig>): string
