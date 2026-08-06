import assert from 'node:assert/strict'
import test from 'node:test'

import { createAIBoxConfig } from '../src/ai-box/config.js'
import { subPcFromProjectRect } from '../src/ai-box/crop.js'
import { fitBox3dFromSubpc } from '../src/ai-box/fit.js'
import { projectCornersToRect } from '../src/ai-box/interaction.js'
import { AIBoxFitter } from '../src/ai-box/index.js'
import { bestBoundingBox2d } from '../src/ai-box/oriented-bbox.js'

test('AI configuration deep-merges and validates values', () => {
  const config = createAIBoxConfig({
    heightRange: [4, -2],
    roadGridSize: -5,
    angleSearch: { round1Count: 1, round2Count: 17 },
  })
  assert.deepEqual(config.heightRange, [-2, 4])
  assert.equal(config.roadGridSize, 0.01)
  assert.equal(config.angleSearch.round1Count, 2)
  assert.equal(config.angleSearch.round2Count, 17)
  assert.equal(config.angleSearch.round3Count, 9)
  assert.equal(createAIBoxConfig().enabled, false)
})

test('ground extraction is lazy and reused inside one sequence', async () => {
  const config = createAIBoxConfig({ enabled: true, useWorker: false })
  const firstFrame = new Float32Array([
    0, 0, 0, 1, 0, 0.05, 0, 1, -0.02, 1, 1, 0.01,
  ])
  const secondFrame = new Float32Array([
    0, 0, 0.02, 1, 0, 0.04, 0, 1, -0.01, 1, 1, 0,
  ])
  const fitter = new AIBoxFitter(() => config)
  fitter.setFrame('0001', firstFrame, 'sequence-a')
  assert.equal(fitter.roadModel, null)
  await fitter.initializeCurrentFrame(config)
  const sequenceRoad = fitter.roadModel
  assert.ok(sequenceRoad)

  fitter.setFrame('0002', secondFrame, 'sequence-a')
  await fitter.initializeCurrentFrame(config)
  assert.equal(fitter.roadModel, sequenceRoad)

  fitter.setFrame('0001', firstFrame, 'sequence-b')
  assert.equal(fitter.roadModel, null)
  await fitter.initializeCurrentFrame(config)
  assert.notEqual(fitter.roadModel, sequenceRoad)
  fitter.resetAIBox()
})

test('screen-space crop keeps only points inside the NDC rectangle', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const points = new Float32Array([
    0, 0, 0,
    0.4, -0.4, 0,
    0.8, 0, 0,
    0, 0, 2,
  ])
  const selected = subPcFromProjectRect(points, [{ x: -0.5, y: -0.5 }, { x: 0.5, y: 0.5 }], identity, [-1, 1])
  assert.equal(selected.length, 6)
  assert.ok(Math.abs(selected[3] - 0.4) < 1e-6)
  assert.ok(Math.abs(selected[4] + 0.4) < 1e-6)
})

function rotatedRectanglePoints(angle, width, height) {
  const values = []
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  for (let index = 0; index <= 10; index += 1) {
    const ratio = index / 10
    for (const [x, y] of [
      [-width / 2 + ratio * width, -height / 2],
      [-width / 2 + ratio * width, height / 2],
      [-width / 2, -height / 2 + ratio * height],
      [width / 2, -height / 2 + ratio * height],
    ]) {
      values.push(cosine * x - sine * y + 3, sine * x + cosine * y - 2, 1)
    }
  }
  return new Float32Array(values)
}

test('oriented fitting recovers a tight long-edge box', () => {
  const config = createAIBoxConfig({ enableDenoise: false })
  const result = bestBoundingBox2d(rotatedRectanglePoints(Math.PI / 6, 4, 2), config)
  assert.ok(result)
  assert.ok(Math.abs(result.centerX - 3) < 0.05)
  assert.ok(Math.abs(result.centerY + 2) < 0.05)
  assert.ok(Math.abs(result.sizeX - 4) < 0.15)
  assert.ok(Math.abs(result.sizeY - 2) < 0.25)
})

test('3D fitting returns null for sparse data and a box for a valid cluster', () => {
  const config = createAIBoxConfig({ enableDenoise: false, minPointsAfterRoadFilter: 4 })
  assert.equal(fitBox3dFromSubpc(new Float32Array([0, 0, 1]), null, 0, config), null)
  const points = rotatedRectanglePoints(0.2, 4, 2)
  const elevated = new Float32Array(points.length * 2)
  elevated.set(points)
  elevated.set(points.map((value, index) => index % 3 === 2 ? 2 : value), points.length)
  const result = fitBox3dFromSubpc(elevated, null, 0.2, config)
  assert.ok(result)
  assert.ok(result.scale.x >= result.scale.y)
  assert.ok(result.scale.z >= 1)
})

test('3D fitting anchors the lower box face to the local ground model', () => {
  const config = createAIBoxConfig({
    enableDenoise: false,
    minPointsAfterRoadFilter: 4,
    roadGap: 0.1,
    roadQueryZOffset: 0,
  })
  const lower = rotatedRectanglePoints(0.2, 4, 2)
  const points = new Float32Array(lower.length * 2)
  points.set(lower)
  points.set(lower.map((value, index) => index % 3 === 2 ? 2 : value), lower.length)
  const roadModel = {
    points: [[3, -2, 0]],
    grid: new Map([['0,-1', [0]]]),
    cellSize: 100,
  }
  const result = fitBox3dFromSubpc(points, roadModel, 0.2, config)
  assert.ok(result)
  const bottomZ = result.position.z - result.scale.z / 2
  assert.ok(Math.abs(bottomZ - 0.1) < 1e-6)
  assert.ok(Math.abs(result.position.z + result.scale.z / 2 - 2) < 1e-6)
})

test('existing-box projection expands and clamps the NDC fitting region', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const corners = [
    -0.2, -0.1, 0, 1,
    0.2, -0.1, 0, 1,
    0.2, 0.1, 0, 1,
    -0.2, 0.1, 0, 1,
  ]
  assert.deepEqual(projectCornersToRect(corners, identity, 0.5), [
    { x: -0.4, y: -0.2 },
    { x: 0.4, y: 0.2 },
  ])
})
