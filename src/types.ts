export type Vec3 = { x: number; y: number; z: number }

export type PSR = {
  position: Vec3
  scale: Vec3
  rotation: Vec3
}

export type LabelBox = {
  obj_id: string | number
  obj_type: string
  psr: PSR
  [key: string]: unknown
}

export type FrameInfo = {
  frame_id: string
  point_file: string
  label_file: string | null
  point_count: number
  byte_size: number
}

export type SequenceInfo = {
  sequence_id: string
  frame_rate: number
  frame_count: number
  has_labels: boolean
}

export type ClassConfig = {
  id: string
  label: string
  color: string
  default_size: [number, number, number]
}

export type LabelsResponse = {
  frame_id: string
  boxes: LabelBox[]
  warnings: string[]
  label_exists: boolean
}

export type PointFrame = {
  frameId: string
  positions: Float32Array
  intensities: Float32Array
}
