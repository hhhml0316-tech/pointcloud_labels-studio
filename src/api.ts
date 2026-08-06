import type { AIBoxConfig, ClassConfig, FrameInfo, LabelsResponse, LabelBox, PointFrame, SequenceInfo } from './types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const body = await response.json()
      detail = body.detail ?? detail
    } catch {
      // Keep the HTTP status when the response is not JSON.
    }
    throw new Error(detail)
  }
  return response.json() as Promise<T>
}

export const api = {
  sequences: () => request<SequenceInfo[]>('/api/sequences'),
  frames: (sequenceId: string) => request<FrameInfo[]>(`/api/sequences/${encodeURIComponent(sequenceId)}/frames`),
  classes: () => request<ClassConfig[]>('/api/config/classes'),
  aiBoxConfig: () => request<AIBoxConfig>('/api/config/ai-box'),
  labels: (sequenceId: string, frameId: string) =>
    request<LabelsResponse>(`/api/sequences/${encodeURIComponent(sequenceId)}/frames/${encodeURIComponent(frameId)}/labels`),
  points: async (sequenceId: string, frameId: string): Promise<ArrayBuffer> => {
    const response = await fetch(`/api/sequences/${encodeURIComponent(sequenceId)}/frames/${encodeURIComponent(frameId)}/points`)
    if (!response.ok) throw new Error(`point file request failed: ${response.status}`)
    return response.arrayBuffer()
  },
  saveLabels: (sequenceId: string, frameId: string, boxes: LabelBox[]) =>
    request<{ status: string; warnings: string[]; backup_file: string | null }>(
      `/api/sequences/${encodeURIComponent(sequenceId)}/frames/${encodeURIComponent(frameId)}/labels`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ boxes }) },
    ),
}

type WorkerResponse = { requestId: number; frame: PointFrame; error?: undefined } | { requestId: number; error: string; frame?: undefined }

export class PointWorkerClient {
  private worker = new Worker(new URL('./pointWorker.ts', import.meta.url), { type: 'module' })
  private nextRequestId = 1
  private pending = new Map<number, { resolve: (frame: PointFrame) => void; reject: (error: Error) => void }>()

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const pending = this.pending.get(event.data.requestId)
      if (!pending) return
      this.pending.delete(event.data.requestId)
      if (event.data.error) pending.reject(new Error(event.data.error))
      else pending.resolve(event.data.frame!)
    }
  }

  decode(frameId: string, buffer: ArrayBuffer): Promise<PointFrame> {
    const requestId = this.nextRequestId++
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
      this.worker.postMessage({ requestId, frameId, buffer }, [buffer])
    })
  }

  dispose() {
    this.worker.terminate()
    this.pending.clear()
  }
}
