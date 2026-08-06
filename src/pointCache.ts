import { api, PointWorkerClient } from './api'
import type { PointFrame } from './types'

export class PointFrameCache {
  private entries = new Map<string, Promise<PointFrame>>()

  constructor(private readonly worker: PointWorkerClient, private readonly maxEntries = 5) {}

  get(sequenceId: string, frameId: string): Promise<PointFrame> {
    const key = `${sequenceId}/${frameId}`
    const existing = this.entries.get(key)
    if (existing) return existing
    const pending = api.points(sequenceId, frameId).then((buffer) => this.worker.decode(frameId, buffer))
    this.entries.set(key, pending)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest) this.entries.delete(oldest)
      else break
    }
    pending.catch(() => this.entries.delete(key))
    return pending
  }

  prefetch(sequenceId: string, frameIds: string[]) {
    frameIds.forEach((frameId) => void this.get(sequenceId, frameId).catch(() => undefined))
  }

  clear() {
    this.entries.clear()
  }
}
