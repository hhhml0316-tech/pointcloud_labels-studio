import type { LabelBox } from './types'

// BEV (top-down) spatial overlap utilities for rotated 3D boxes. Used to
// detect when two boxes with different Track IDs likely describe the same
// physical object, e.g. during adjacent-frame merges or single-box sync.

export type PolyPoint = { x: number; y: number }

// Two boxes are treated as "probably the same target" when their BEV
// intersection-over-union or center distance passes either threshold.
export const SAME_TARGET_IOU_THRESHOLD = 0.2
export const SAME_TARGET_DISTANCE_THRESHOLD = 1.0

export function isProbablySameTarget(metric: { iou: number; distance: number }): boolean {
  return metric.iou >= SAME_TARGET_IOU_THRESHOLD || metric.distance <= SAME_TARGET_DISTANCE_THRESHOLD
}

export function bevCorners(box: LabelBox): PolyPoint[] {
  const { position, scale, rotation } = box.psr
  const cos = Math.cos(rotation.z)
  const sin = Math.sin(rotation.z)
  const halfX = Math.abs(scale.x) / 2
  const halfY = Math.abs(scale.y) / 2
  // Counter-clockwise order; rotation preserves orientation, which the
  // Sutherland-Hodgman clipping below relies on.
  const local: PolyPoint[] = [
    { x: halfX, y: halfY },
    { x: -halfX, y: halfY },
    { x: -halfX, y: -halfY },
    { x: halfX, y: -halfY },
  ]
  return local.map((point) => ({
    x: position.x + point.x * cos - point.y * sin,
    y: position.y + point.x * sin + point.y * cos,
  }))
}

export function polygonArea(polygon: PolyPoint[]): number {
  if (polygon.length < 3) return 0
  let area = 0
  for (let i = 0; i < polygon.length; i += 1) {
    const current = polygon[i]
    const next = polygon[(i + 1) % polygon.length]
    area += current.x * next.y - next.x * current.y
  }
  return Math.abs(area) / 2
}

function isInsideEdge(point: PolyPoint, edgeStart: PolyPoint, edgeEnd: PolyPoint): boolean {
  return (edgeEnd.x - edgeStart.x) * (point.y - edgeStart.y) - (edgeEnd.y - edgeStart.y) * (point.x - edgeStart.x) >= 0
}

function edgeIntersection(p1: PolyPoint, p2: PolyPoint, p3: PolyPoint, p4: PolyPoint): PolyPoint {
  const denominator = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x)
  if (Math.abs(denominator) < 1e-12) return { x: p2.x, y: p2.y }
  const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / denominator
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) }
}

// Sutherland-Hodgman clipping; both polygons are convex and CCW.
function clipPolygon(subject: PolyPoint[], clip: PolyPoint[]): PolyPoint[] {
  let output = subject
  for (let i = 0; i < clip.length; i += 1) {
    if (!output.length) break
    const edgeStart = clip[i]
    const edgeEnd = clip[(i + 1) % clip.length]
    const input = output
    output = []
    let previous = input[input.length - 1]
    for (const current of input) {
      const currentInside = isInsideEdge(current, edgeStart, edgeEnd)
      const previousInside = isInsideEdge(previous, edgeStart, edgeEnd)
      if (currentInside) {
        if (!previousInside) output.push(edgeIntersection(previous, current, edgeStart, edgeEnd))
        output.push(current)
      } else if (previousInside) {
        output.push(edgeIntersection(previous, current, edgeStart, edgeEnd))
      }
      previous = current
    }
  }
  return output
}

export function bevIou(a: LabelBox, b: LabelBox): number {
  const polygonA = bevCorners(a)
  const polygonB = bevCorners(b)
  const intersection = clipPolygon(polygonA, polygonB)
  const intersectionArea = polygonArea(intersection)
  if (intersectionArea <= 0) return 0
  const unionArea = polygonArea(polygonA) + polygonArea(polygonB) - intersectionArea
  return unionArea > 0 ? intersectionArea / unionArea : 0
}

export function bevCenterDistance(a: LabelBox, b: LabelBox): number {
  const dx = a.psr.position.x - b.psr.position.x
  const dy = a.psr.position.y - b.psr.position.y
  return Math.hypot(dx, dy)
}

export type SpatialMetric = { iou: number; distance: number }

export function spatialMetric(a: LabelBox, b: LabelBox): SpatialMetric {
  return { iou: bevIou(a, b), distance: bevCenterDistance(a, b) }
}

export type SpatialCandidate = { box: LabelBox; iou: number; distance: number }

// Rank other boxes by how likely they are to be the same target as the
// reference box, keeping only plausible matches.
export function findSpatialCandidates(reference: LabelBox, others: LabelBox[], limit = 5): SpatialCandidate[] {
  const candidates: SpatialCandidate[] = []
  for (const box of others) {
    if (String(box.obj_id) === String(reference.obj_id)) continue
    const metric = spatialMetric(reference, box)
    if (metric.iou >= 0.02 || metric.distance <= SAME_TARGET_DISTANCE_THRESHOLD * 2) {
      candidates.push({ box, iou: metric.iou, distance: metric.distance })
    }
  }
  candidates.sort((a, b) => b.iou - a.iou || a.distance - b.distance)
  return candidates.slice(0, limit)
}
