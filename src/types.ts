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

export type AIBoxConfig = {
  enabled: boolean
  minBoxSize: number
  heightRange: [number, number]
  roadGridSize: number
  roadZStatSigmaLow: number
  roadZStatSigmaHigh: number
  roadCellLowestMargin: number
  roadOutlierK: number
  roadOutlierStdMul: number
  roadMaxSlopeDeg: number
  roadSlopeSearchMul: number
  roadQueryZOffset: number
  roadGap: number
  minPointsAfterRoadFilter: number
  enableDenoise: boolean
  minFilterPoints: number
  dbscanEps: number
  dbscanMinPts: number
  angleSearch: {
    round1Count: number
    round2Count: number
    round3Count: number
  }
  edgeGap: number
  lossScale: number
  preferLongEdgeAsX: boolean
  useHeadAngle: boolean
  headFlipThresholdRad: number
  existingBoxFitPaddingRatio: number
  useWorker: boolean
  maxPointsForFit?: number
}

export type AIBoxFitResult = {
  position: Vec3
  scale: Vec3
  rotation: Vec3
  diagnostics?: {
    inputPointCount: number
    fittedPointCount: number
    roadZ: number | null
    loss: number
  }
}

export type AIBoxSelection = {
  projectRect: [{ x: number; y: number }, { x: number; y: number }]
  viewProjMatrix: number[]
  headAngle: number
  worldCenter: Vec3
}
