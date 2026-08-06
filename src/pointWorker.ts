type DecodeMessage = { requestId: number; frameId: string; buffer: ArrayBuffer }
const workerScope = self as unknown as { postMessage: (message: unknown, transfer?: Transferable[]) => void }

self.onmessage = (event: MessageEvent<DecodeMessage>) => {
  const { requestId, frameId, buffer } = event.data
  try {
    if (buffer.byteLength % 16 !== 0) throw new Error(`invalid XYZI buffer size: ${buffer.byteLength}`)
    const source = new Float32Array(buffer)
    const count = source.length / 4
    const positions = new Float32Array(count * 3)
    const intensities = new Float32Array(count)
    for (let index = 0; index < count; index += 1) {
      const sourceOffset = index * 4
      const targetOffset = index * 3
      positions[targetOffset] = source[sourceOffset]
      positions[targetOffset + 1] = source[sourceOffset + 1]
      positions[targetOffset + 2] = source[sourceOffset + 2]
      intensities[index] = source[sourceOffset + 3]
    }
    workerScope.postMessage({ requestId, frame: { frameId, positions, intensities } }, [positions.buffer, intensities.buffer])
  } catch (error) {
    workerScope.postMessage({ requestId, error: error instanceof Error ? error.message : String(error) })
  }
}
