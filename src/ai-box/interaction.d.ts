export function projectCornersToRect(
  corners: ArrayLike<number>,
  matrix: ArrayLike<number>,
  paddingRatio?: number,
): [{ x: number; y: number }, { x: number; y: number }] | null
