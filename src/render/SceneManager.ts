import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { projectCornersToRect } from '../ai-box/interaction.js'
import type { AIBoxSelection, ClassConfig, LabelBox, PointFrame, Vec3 } from '../types'

export type ViewName = 'main' | 'bev' | 'front' | 'side'

type Viewport = { x: number; y: number; width: number; height: number }

type DragState = {
  view: Exclude<ViewName, 'main'>
  boxId: string
  pointerId: number
  plane: THREE.Plane
  startPoint: THREE.Vector3
  startPosition: THREE.Vector3
  change: BoxTransformChange
}

export type BoxTransformChange = {
  position?: Vec3
  scale?: Vec3
  rotation?: Vec3
}

type ViewAxisSpec = {
  u: 'x' | 'y' | 'z'
  v: 'x' | 'y' | 'z'
  rotation: 'x' | 'y' | 'z'
  normal: THREE.Vector3
}

type OverlayView = {
  svg: SVGSVGElement
  polygon: SVGPolygonElement
  direction: SVGLineElement
  handles: Record<string, SVGElement>
}

type MainBoxLabel = {
  element: HTMLDivElement
  center: THREE.Vector3
}

type BoxDrawState = {
  pointerId: number
  startClient: { x: number; y: number }
  startNdc: THREE.Vector2
}

const EDITOR_BOX_RANGE_RATIO = 1.5
const EDITOR_CONTEXT_DEPTH_RATIO = 3

const POINT_COLOR_LUT = (() => {
  const values = new Float32Array(256 * 3)
  const color = new THREE.Color()
  for (let index = 0; index < 256; index += 1) {
    color.setHSL(0.66 - (index / 255) * 0.66, 0.85, 0.55)
    values[index * 3] = color.r
    values[index * 3 + 1] = color.g
    values[index * 3 + 2] = color.b
  }
  return values
})()

type ControlDrag = {
  view: Exclude<ViewName, 'main'>
  kind: 'move' | 'scale' | 'rotate'
  direction: { u: number; v: number }
  plane: THREE.Plane
  startWorld: THREE.Vector3
  startScreen: { x: number; y: number }
  centerScreen: { x: number; y: number }
  startPosition: Vec3
  startScale: Vec3
  startRotation: Vec3
  change: BoxTransformChange
}

/**
 * The main canvas is intentionally a single, large XY bird's-eye view.
 * The editor canvas is a separate three-viewport sidebar used for box editing.
 */
export class SceneManager {
  private readonly mainRenderer: THREE.WebGLRenderer
  private readonly editorRenderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly mainCanvas: HTMLCanvasElement
  private readonly mainOverlay: HTMLDivElement
  private readonly editorCanvas: HTMLCanvasElement
  private readonly editorOverlay: HTMLDivElement
  private readonly mainCamera = new THREE.PerspectiveCamera(65, 1, 0.1, 10000)
  private readonly boxCreationCamera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 10000)
  private readonly bevCamera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 10000)
  private readonly frontCamera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 10000)
  private readonly sideCamera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 10000)
  private readonly controls: OrbitControls
  private readonly pointGroup = new THREE.Group()
  private readonly boxGroup = new THREE.Group()
  private points: THREE.Points | null = null
  private editorPoints: THREE.Points | null = null
  private pointData: PointFrame | null = null
  private pointSize = 1.5
  private colorMode: 'intensity' | 'uniform' | 'height' = 'intensity'
  private classes = new Map<string, ClassConfig>()
  private mainViewport: Viewport = { x: 0, y: 0, width: 1, height: 1 }
  private editorViewports: Record<Exclude<ViewName, 'main'>, Viewport> = {
    bev: { x: 0, y: 0, width: 1, height: 1 },
    front: { x: 0, y: 0, width: 1, height: 1 },
    side: { x: 0, y: 0, width: 1, height: 1 },
  }
  private dragState: DragState | null = null
  private selectedId: string | null = null
  private editorFocusedId: string | null = null
  private selectedBoxModel: LabelBox | null = null
  private readonly overlayViews: Record<Exclude<ViewName, 'main'>, OverlayView> = {} as Record<Exclude<ViewName, 'main'>, OverlayView>
  private controlDrag: ControlDrag | null = null
  private shouldFitMainView = true
  private mainBoxLabels: MainBoxLabel[] = []
  private currentBoxes: LabelBox[] = []
  private lastLabelClick: { x: number; y: number; time: number; ids: string; index: number } | null = null
  private readonly boxSelectionRect = document.createElement('div')
  private boxCreationMode = false
  private boxDrawState: BoxDrawState | null = null
  private previewBox: LabelBox | null = null
  private pointBounds: THREE.Sphere | null = null
  private boxCreationHalfHeight = 100

  constructor(
    mainCanvas: HTMLCanvasElement,
    mainOverlay: HTMLDivElement,
    editorCanvas: HTMLCanvasElement,
    editorOverlay: HTMLDivElement,
    private readonly onSelect: (id: string | null) => void,
    private readonly onTransform: (id: string, change: BoxTransformChange) => void,
    private readonly onMoveEnd: () => void,
    private readonly onCreateRegion: (selection: AIBoxSelection) => void,
    private readonly onBoxContextMenu: (id: string, clientX: number, clientY: number) => void,
  ) {
    this.mainCanvas = mainCanvas
    this.mainOverlay = mainOverlay
    this.editorCanvas = editorCanvas
    this.editorOverlay = editorOverlay
    this.mainRenderer = this.createRenderer(mainCanvas, true)
    this.editorRenderer = this.createRenderer(editorCanvas)
    this.bevCamera.layers.set(1)
    this.frontCamera.layers.set(1)
    this.sideCamera.layers.set(1)
    // The editor cameras use layer 1.  Keep the parent groups on both layers
    // so their layer-1 children (the selected box and its local point cloud)
    // are traversed by Three.js.
    this.pointGroup.layers.enable(1)
    this.boxGroup.layers.enable(1)
    this.createEditorOverlay()
    this.boxSelectionRect.className = 'ai-box-selection-rect'
    this.boxSelectionRect.hidden = true
    this.mainOverlay.append(this.boxSelectionRect)
    this.scene.add(this.pointGroup, this.boxGroup)
    this.scene.add(new THREE.AmbientLight(0xffffff, 1))
    this.scene.add(new THREE.AxesHelper(5))

    // SUSTechPOINTS treats Z as the vertical axis. OrbitControls derives all
    // azimuth/polar movement from camera.up, so using Three.js' Y-up default
    // makes a point-cloud scene orbit around the wrong world axis.
    this.mainCamera.up.set(0, 0, 1)
    this.mainCamera.position.set(0, -0.01, 50)
    this.mainCamera.lookAt(0, 0, 0)
    this.controls = new OrbitControls(this.mainCamera, mainCanvas)
    this.controls.enableDamping = false
    this.controls.screenSpacePanning = false
    this.controls.enableRotate = true

    this.mainCanvas.addEventListener('pointerdown', this.handleMainPointerDown)
    this.mainCanvas.addEventListener('pointermove', this.handleMainPointerMove)
    this.mainCanvas.addEventListener('pointerup', this.handleMainPointerUp)
    this.mainCanvas.addEventListener('pointercancel', this.handleMainPointerCancel)
    this.mainCanvas.addEventListener('contextmenu', this.handleMainContextMenu)
    this.editorCanvas.addEventListener('pointerdown', this.handleEditorPointerDown)
    this.editorCanvas.addEventListener('pointermove', this.handleEditorPointerMove)
    window.addEventListener('pointerup', this.handlePointerUp)
    this.resize()
  }

  setClasses(classes: ClassConfig[]) {
    this.classes = new Map(classes.map((item) => [item.id, item]))
  }

  setPointStyle(size: number, colorMode: 'intensity' | 'uniform' | 'height') {
    this.pointSize = size
    this.colorMode = colorMode
    if (this.pointData) this.setPoints(this.pointData)
  }

  fitMainViewOnNextFrame() {
    this.shouldFitMainView = true
  }

  setBoxCreationMode(enabled: boolean) {
    const drawPointerId = this.boxDrawState?.pointerId
    if (drawPointerId !== undefined && this.mainCanvas.hasPointerCapture(drawPointerId)) {
      this.mainCanvas.releasePointerCapture(drawPointerId)
    }
    this.boxCreationMode = enabled
    this.boxDrawState = null
    this.boxSelectionRect.hidden = true
    this.boxSelectionRect.removeAttribute('style')
    this.controls.enabled = !enabled
    this.mainCanvas.classList.toggle('box-creation-active', enabled)
    this.clearMainBoxLabels()
    if (enabled) {
      this.configureBoxCreationCamera()
    } else {
      this.currentBoxes.forEach((box) => this.addMainBoxLabel(box))
      // Reproject immediately with the restored perspective camera. This keeps
      // labels from spending even one frame at their former BEV coordinates.
      this.updateMainBoxLabels()
    }
  }

  getBoxFitSelection(box: LabelBox, paddingRatio: number): AIBoxSelection | null {
    this.mainCamera.updateMatrixWorld(true)
    const viewProjMatrix = this.mainViewProjection()
    const half = {
      x: Math.abs(box.psr.scale.x) * 0.5,
      y: Math.abs(box.psr.scale.y) * 0.5,
      z: Math.abs(box.psr.scale.z) * 0.5,
    }
    const rotation = new THREE.Euler(box.psr.rotation.x, box.psr.rotation.y, box.psr.rotation.z, 'XYZ')
    const center = new THREE.Vector3(box.psr.position.x, box.psr.position.y, box.psr.position.z)
    const corners: number[] = []
    for (const x of [-half.x, half.x]) {
      for (const y of [-half.y, half.y]) {
        for (const z of [-half.z, half.z]) {
          const corner = new THREE.Vector3(x, y, z).applyEuler(rotation).add(center)
          corners.push(corner.x, corner.y, corner.z, 1)
        }
      }
    }
    const projectRect = projectCornersToRect(corners, viewProjMatrix, paddingRatio)
    if (!projectRect) return null
    return {
      projectRect,
      viewProjMatrix,
      headAngle: box.psr.rotation.z,
      worldCenter: { ...box.psr.position },
    }
  }

  setPoints(data: PointFrame) {
    this.pointData = data
    if (this.editorPoints) {
      this.pointGroup.remove(this.editorPoints)
      this.disposeObject(this.editorPoints)
      this.editorPoints = null
    }
    if (this.points) {
      this.pointGroup.remove(this.points)
      this.disposeObject(this.points)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
    if (this.colorMode !== 'uniform') geometry.setAttribute('color', new THREE.BufferAttribute(this.makeColors(data), 3))
    const material = new THREE.PointsMaterial({
      size: this.pointSize,
      sizeAttenuation: false,
      color: this.colorMode === 'uniform' ? 0x9ec5ff : 0xffffff,
      vertexColors: this.colorMode !== 'uniform',
    })
    this.points = new THREE.Points(geometry, material)
    // Main view renders the complete cloud. The editor gets a separate
    // layer-1 cloud containing the selected box and its nearby context.
    this.points.layers.set(0)
    this.pointGroup.add(this.points)
    geometry.computeBoundingSphere()
    this.pointBounds = geometry.boundingSphere?.clone() ?? null
    if (this.boxCreationMode) this.configureBoxCreationCamera()
    if (this.shouldFitMainView) {
      this.fitToPoints(data.positions)
      this.shouldFitMainView = false
    }
    this.updateEditorPointCloud()
    if (this.selectedBoxModel) this.focusEditorBox(this.selectedBoxModel)
  }

  setBoxes(boxes: LabelBox[], selectedId: string | null) {
    this.selectedId = selectedId
    this.currentBoxes = [...boxes]
    for (const child of [...this.boxGroup.children]) {
      this.boxGroup.remove(child)
      child.traverse((node) => {
        const mesh = node as THREE.Mesh | THREE.LineSegments
        if (mesh.geometry) mesh.geometry.dispose()
        if (mesh.material) {
          if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose())
          else mesh.material.dispose()
        }
      })
    }
    this.mainOverlay.replaceChildren(this.boxSelectionRect)
    this.mainBoxLabels = []
    boxes.forEach((box) => {
      this.addBox(box)
      if (!this.boxCreationMode) this.addMainBoxLabel(box)
    })
    const selectedBox = boxes.find((box) => String(box.obj_id) === selectedId)
    this.selectedBoxModel = selectedBox ?? null
    if (!selectedBox) {
      this.editorFocusedId = null
    }
    this.updateEditorPointCloud()
    if (selectedBox) {
      // SUST keeps all three orthographic cameras attached to the active box;
      // update this when selection changes or after a completed edit.  During
      // an active drag the camera must stay fixed, otherwise the ray-plane
      // delta changes underneath the pointer and scaling is not free.
      if (this.editorFocusedId !== selectedId || (!this.controlDrag && !this.dragState)) {
        this.focusEditorBox(selectedBox)
      }
      this.editorFocusedId = selectedId
    }
  }

  render() {
    this.resize()
    this.controls.update()

    const mainWidth = Math.max(1, this.mainCanvas.clientWidth)
    const mainHeight = Math.max(1, this.mainCanvas.clientHeight)
    this.mainRenderer.setScissorTest(false)
    this.mainRenderer.setViewport(0, 0, mainWidth, mainHeight)
    this.mainRenderer.clear()
    this.mainRenderer.render(this.scene, this.activeMainCamera())
    this.updateMainBoxLabels()

    const editorWidth = Math.max(1, this.editorCanvas.clientWidth)
    const editorHeight = Math.max(1, this.editorCanvas.clientHeight)
    this.editorRenderer.setScissorTest(false)
    this.editorRenderer.setViewport(0, 0, editorWidth, editorHeight)
    this.editorRenderer.clear()
    this.editorRenderer.setScissorTest(true)
    for (const view of ['bev', 'front', 'side'] as const) {
      const viewport = this.editorViewports[view]
      this.editorRenderer.setViewport(viewport.x, viewport.y, viewport.width, viewport.height)
      this.editorRenderer.setScissor(viewport.x, viewport.y, viewport.width, viewport.height)
      this.editorRenderer.render(this.scene, this.cameraFor(view))
    }
    this.updateEditorOverlay()
  }

  resize() {
    const mainWidth = Math.max(1, this.mainCanvas.clientWidth)
    const mainHeight = Math.max(1, this.mainCanvas.clientHeight)
    const editorWidth = Math.max(1, this.editorCanvas.clientWidth)
    const editorHeight = Math.max(1, this.editorCanvas.clientHeight)
    this.mainRenderer.setSize(mainWidth, mainHeight, false)
    this.editorRenderer.setSize(editorWidth, editorHeight, false)
    this.mainViewport = { x: 0, y: 0, width: mainWidth, height: mainHeight }
    const rowHeight = Math.max(1, Math.floor(editorHeight / 3))
    this.editorViewports = {
      bev: { x: 0, y: rowHeight * 2, width: editorWidth, height: editorHeight - rowHeight * 2 },
      front: { x: 0, y: rowHeight, width: editorWidth, height: rowHeight },
      side: { x: 0, y: 0, width: editorWidth, height: rowHeight },
    }
    this.updateOrtho(this.bevCamera, this.editorViewports.bev, 100)
    this.updateOrtho(this.frontCamera, this.editorViewports.front, 100)
    this.updateOrtho(this.sideCamera, this.editorViewports.side, 100)
    this.mainCamera.aspect = mainWidth / Math.max(1, mainHeight)
    this.mainCamera.updateProjectionMatrix()
    this.updateOrtho(this.boxCreationCamera, this.mainViewport, this.boxCreationHalfHeight)
    this.layoutEditorOverlay(editorWidth, editorHeight)
  }

  dispose() {
    this.mainCanvas.removeEventListener('pointerdown', this.handleMainPointerDown)
    this.mainCanvas.removeEventListener('pointermove', this.handleMainPointerMove)
    this.mainCanvas.removeEventListener('pointerup', this.handleMainPointerUp)
    this.mainCanvas.removeEventListener('pointercancel', this.handleMainPointerCancel)
    this.mainCanvas.removeEventListener('contextmenu', this.handleMainContextMenu)
    this.editorCanvas.removeEventListener('pointerdown', this.handleEditorPointerDown)
    this.editorCanvas.removeEventListener('pointermove', this.handleEditorPointerMove)
    window.removeEventListener('pointerup', this.handlePointerUp)
    window.removeEventListener('pointermove', this.handleControlPointerMove)
    window.removeEventListener('pointerup', this.handleControlPointerUp)
    this.editorOverlay.replaceChildren()
    this.mainOverlay.replaceChildren()
    this.mainBoxLabels = []
    this.controls.dispose()
    this.mainRenderer.dispose()
    this.editorRenderer.dispose()
  }

  private createEditorOverlay() {
    const svgNamespace = 'http://www.w3.org/2000/svg'
    for (const view of ['bev', 'front', 'side'] as const) {
      const svg = document.createElementNS(svgNamespace, 'svg')
      svg.classList.add('editor-overlay-view', `editor-overlay-${view}`)
      svg.style.pointerEvents = 'none'
      const polygon = document.createElementNS(svgNamespace, 'polygon')
      polygon.classList.add('box-control-outline')
      const direction = document.createElementNS(svgNamespace, 'line')
      direction.classList.add('box-control-direction')
      svg.append(polygon, direction)
      const handles: Record<string, SVGElement> = {}
      const screenU = this.screenAxisSigns(view).u
      const directions: Record<string, { u: number; v: number }> = {
        top: { u: 0, v: 1 },
        right: { u: screenU, v: 0 },
        bottom: { u: 0, v: -1 },
        left: { u: -screenU, v: 0 },
        topleft: { u: -screenU, v: 1 },
        topright: { u: screenU, v: 1 },
        bottomright: { u: screenU, v: -1 },
        bottomleft: { u: -screenU, v: -1 },
      }
      // Put corner hit targets first and edge hit targets last. The edge target
      // should win at the midpoint of a short edge; otherwise a 12px corner
      // target can overlap it and accidentally resize two axes at once.
      const handleOrder = [
        'topleft',
        'topright',
        'bottomright',
        'bottomleft',
        'top',
        'right',
        'bottom',
        'left',
      ]
      for (const name of handleOrder) {
        const handle = document.createElementNS(svgNamespace, 'rect')
        handle.classList.add('box-control-handle', `box-control-${name}`)
        handle.setAttribute('width', '16')
        handle.setAttribute('height', '16')
        handle.style.pointerEvents = 'all'
        handle.addEventListener('pointerdown', (event) => this.beginControlDrag(event, view, 'scale', directions[name]))
        handles[name] = handle
        svg.append(handle)
      }
      const move = document.createElementNS(svgNamespace, 'circle')
      move.classList.add('box-control-handle', 'box-control-move')
      move.setAttribute('r', '8')
      move.style.pointerEvents = 'all'
      move.addEventListener('pointerdown', (event) => this.beginControlDrag(event, view, 'move', { u: 0, v: 0 }))
      handles.move = move
      svg.append(move)
      const rotate = document.createElementNS(svgNamespace, 'circle')
      rotate.classList.add('box-control-handle', 'box-control-rotate')
      rotate.setAttribute('r', '8')
      rotate.style.pointerEvents = 'all'
      rotate.addEventListener('pointerdown', (event) => this.beginControlDrag(event, view, 'rotate', { u: 0, v: 0 }))
      handles.rotate = rotate
      svg.append(rotate)
      this.editorOverlay.append(svg)
      this.overlayViews[view] = { svg, polygon, direction, handles }
    }
  }

  private layoutEditorOverlay(editorWidth: number, editorHeight: number) {
    for (const view of ['bev', 'front', 'side'] as const) {
      const viewport = this.editorViewports[view]
      const overlay = this.overlayViews[view]
      if (!overlay) continue
      const top = editorHeight - viewport.y - viewport.height
      overlay.svg.style.left = `${viewport.x}px`
      overlay.svg.style.top = `${top}px`
      overlay.svg.style.width = `${viewport.width}px`
      overlay.svg.style.height = `${viewport.height}px`
      overlay.svg.setAttribute('viewBox', `0 0 ${viewport.width} ${viewport.height}`)
    }
  }

  private viewAxisSpec(view: Exclude<ViewName, 'main'>): ViewAxisSpec {
    // Match SUST's projective cameras exactly: TOP uses local +X as screen-up
    // and local -Y as screen-right; the two elevation views use local +Z up.
    if (view === 'bev') return { u: 'y', v: 'x', rotation: 'z', normal: new THREE.Vector3(0, 0, 1) }
    if (view === 'front') return { u: 'x', v: 'z', rotation: 'y', normal: new THREE.Vector3(0, 1, 0) }
    return { u: 'y', v: 'z', rotation: 'x', normal: new THREE.Vector3(1, 0, 0) }
  }

  private screenAxisSigns(view: Exclude<ViewName, 'main'>) {
    return { u: view === 'front' ? 1 : -1, v: 1 }
  }

  private projectPoint(point: THREE.Vector3, view: Exclude<ViewName, 'main'>) {
    const viewport = this.editorViewports[view]
    const projected = point.clone().project(this.cameraFor(view))
    return {
      x: (projected.x + 1) * 0.5 * viewport.width,
      y: (1 - projected.y) * 0.5 * viewport.height,
    }
  }

  private projectBox(view: Exclude<ViewName, 'main'>) {
    const box = this.previewBox ?? this.selectedBoxModel
    if (!box) return null
    const spec = this.viewAxisSpec(view)
    const position = new THREE.Vector3(box.psr.position.x, box.psr.position.y, box.psr.position.z)
    const rotation = new THREE.Euler(box.psr.rotation.x, box.psr.rotation.y, box.psr.rotation.z, 'XYZ')
    const quaternion = new THREE.Quaternion().setFromEuler(rotation)
    const halfU = Math.abs(box.psr.scale[spec.u]) * 0.5
    const halfV = Math.abs(box.psr.scale[spec.v]) * 0.5
    const corners = [
      new THREE.Vector3(-halfU, -halfV, 0),
      new THREE.Vector3(halfU, -halfV, 0),
      new THREE.Vector3(halfU, halfV, 0),
      new THREE.Vector3(-halfU, halfV, 0),
    ].map((corner) => {
      const local = new THREE.Vector3()
      local[spec.u] = corner.x
      local[spec.v] = corner.y
      return this.projectPoint(local.applyQuaternion(quaternion).add(position), view)
    })
    const signs = this.screenAxisSigns(view)
    const cornerIndex = (uSign: number, vSign: number) => {
      if (uSign < 0 && vSign < 0) return 0
      if (uSign > 0 && vSign < 0) return 1
      if (uSign > 0 && vSign > 0) return 2
      return 3
    }
    const screenCorners = [
      corners[cornerIndex(-signs.u, -signs.v)],
      corners[cornerIndex(signs.u, -signs.v)],
      corners[cornerIndex(signs.u, signs.v)],
      corners[cornerIndex(-signs.u, signs.v)],
    ]
    const center = screenCorners.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 })
    return { corners: screenCorners, center }
  }

  private setSvgPoint(element: SVGElement, point: { x: number; y: number }) {
    if (element.tagName === 'circle') {
      element.setAttribute('cx', `${point.x}`)
      element.setAttribute('cy', `${point.y}`)
    } else {
      element.setAttribute('x', `${point.x - 8}`)
      element.setAttribute('y', `${point.y - 8}`)
    }
  }

  private directionToViewportEdge(
    center: { x: number; y: number },
    direction: { x: number; y: number },
    viewport: Viewport,
  ) {
    const margin = 10
    const candidates: number[] = []
    if (Math.abs(direction.x) > 1e-6) {
      candidates.push((margin - center.x) / direction.x)
      candidates.push((viewport.width - margin - center.x) / direction.x)
    }
    if (Math.abs(direction.y) > 1e-6) {
      candidates.push((margin - center.y) / direction.y)
      candidates.push((viewport.height - margin - center.y) / direction.y)
    }
    const distance = Math.min(...candidates.filter((value) => value > 0))
    if (!Number.isFinite(distance)) return center
    return {
      x: center.x + direction.x * distance,
      y: center.y + direction.y * distance,
    }
  }

  private updateEditorOverlay() {
    for (const view of ['bev', 'front', 'side'] as const) {
      const overlay = this.overlayViews[view]
      if (!overlay) continue
      const projection = this.projectBox(view)
      overlay.svg.style.display = projection ? '' : 'none'
      if (!projection) continue
      overlay.polygon.setAttribute('points', projection.corners.map((point) => `${point.x},${point.y}`).join(' '))
      const top = {
        x: (projection.corners[2].x + projection.corners[3].x) * 0.5,
        y: (projection.corners[2].y + projection.corners[3].y) * 0.5,
      }
      const direction = { x: top.x - projection.center.x, y: top.y - projection.center.y }
      const directionLength = Math.max(1, Math.hypot(direction.x, direction.y))
      const directionUnit = { x: direction.x / directionLength, y: direction.y / directionLength }
      const rotationHandle = this.directionToViewportEdge(projection.center, directionUnit, this.editorViewports[view])
      overlay.direction.setAttribute('x1', `${projection.center.x}`)
      overlay.direction.setAttribute('y1', `${projection.center.y}`)
      overlay.direction.setAttribute('x2', `${rotationHandle.x}`)
      overlay.direction.setAttribute('y2', `${rotationHandle.y}`)
      const corners = projection.corners
      const edgePoints: Record<string, { x: number; y: number }> = {
        top: { x: (corners[2].x + corners[3].x) * 0.5, y: (corners[2].y + corners[3].y) * 0.5 },
        right: { x: (corners[1].x + corners[2].x) * 0.5, y: (corners[1].y + corners[2].y) * 0.5 },
        bottom: { x: (corners[0].x + corners[1].x) * 0.5, y: (corners[0].y + corners[1].y) * 0.5 },
        left: { x: (corners[3].x + corners[0].x) * 0.5, y: (corners[3].y + corners[0].y) * 0.5 },
        topleft: corners[3],
        topright: corners[2],
        bottomright: corners[1],
        bottomleft: corners[0],
        move: projection.center,
        rotate: rotationHandle,
      }
      for (const [name, point] of Object.entries(edgePoints)) this.setSvgPoint(overlay.handles[name], point)
    }
  }

  private beginControlDrag(
    event: PointerEvent,
    view: Exclude<ViewName, 'main'>,
    kind: ControlDrag['kind'],
    direction: { u: number; v: number },
  ) {
    if (!this.selectedBoxModel) return
    event.preventDefault()
    event.stopPropagation()
    const box = this.selectedBoxModel
    const spec = this.viewAxisSpec(view)
    const raycaster = new THREE.Raycaster()
    const ndc = this.pointerNdc(this.editorCanvas, event, this.editorViewports[view])
    raycaster.setFromCamera(ndc, this.cameraFor(view))
    const center = new THREE.Vector3(box.psr.position.x, box.psr.position.y, box.psr.position.z)
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(box.psr.rotation.x, box.psr.rotation.y, box.psr.rotation.z, 'XYZ'))
    const viewNormal = spec.normal.clone().applyQuaternion(quaternion).normalize()
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewNormal, center)
    const startWorld = plane.intersectLine(new THREE.Line3(raycaster.ray.origin, raycaster.ray.origin.clone().add(raycaster.ray.direction.multiplyScalar(100000))), new THREE.Vector3())
    if (!startWorld) return
    const projection = this.projectBox(view)
    if (!projection) return
    const viewportRect = this.editorCanvas.getBoundingClientRect()
    const viewport = this.editorViewports[view]
    const overlayTop = viewportRect.height - viewport.y - viewport.height
    const centerScreen = {
      x: viewportRect.left + projection.center.x,
      y: viewportRect.top + overlayTop + projection.center.y,
    }
      this.controlDrag = {
      view,
      kind,
      direction,
      plane,
      startWorld,
      startScreen: { x: event.clientX, y: event.clientY },
      centerScreen,
      startPosition: { ...box.psr.position },
      startScale: { ...box.psr.scale },
      startRotation: { ...box.psr.rotation },
      change: {},
    }
    this.previewBox = this.cloneBox(box)
    window.addEventListener('pointermove', this.handleControlPointerMove)
    window.addEventListener('pointerup', this.handleControlPointerUp)
    this.editorCanvas.style.cursor = kind === 'rotate' ? 'crosshair' : kind === 'scale' ? 'nwse-resize' : 'move'
    this.onSelect(String(box.obj_id))
  }

  private handleControlPointerMove = (event: PointerEvent) => {
    const drag = this.controlDrag
    const box = this.selectedBoxModel
    if (!drag || !box) return
    const spec = this.viewAxisSpec(drag.view)
    if (drag.kind === 'rotate') {
      const startAngle = Math.atan2(drag.startScreen.y - drag.centerScreen.y, drag.startScreen.x - drag.centerScreen.x)
      const currentAngle = Math.atan2(event.clientY - drag.centerScreen.y, event.clientX - drag.centerScreen.x)
      let delta = currentAngle - startAngle
      while (delta > Math.PI) delta -= Math.PI * 2
      while (delta < -Math.PI) delta += Math.PI * 2
      // Apply the rotation around the box's local view normal, matching the
      // quaternion composition used by SUST's projective views.  Adding to
      // one Euler component would rotate around a world axis after tilt.
      const startQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        drag.startRotation.x,
        drag.startRotation.y,
        drag.startRotation.z,
        'XYZ',
      ))
      const localU = new THREE.Vector3()
      localU[spec.u] = 1
      const localV = new THREE.Vector3()
      localV[spec.v] = 1
      const localNormal = localU.clone().cross(localV)
      const axis = new THREE.Vector3()
      axis[spec.rotation] = 1
      const handedness = Math.sign(localNormal.dot(axis)) || 1
      const screenU = this.screenAxisSigns(drag.view).u
      const rotationQuaternion = new THREE.Quaternion().setFromAxisAngle(axis, -handedness * screenU * delta)
      const rotation = new THREE.Euler().setFromQuaternion(startQuaternion.multiply(rotationQuaternion), 'XYZ')
      const change = { rotation: { x: rotation.x, y: rotation.y, z: rotation.z } }
      drag.change = change
      this.applyBoxPreview(change)
      return
    }
    const raycaster = new THREE.Raycaster()
    const ndc = this.pointerNdc(this.editorCanvas, event, this.editorViewports[drag.view])
    raycaster.setFromCamera(ndc, this.cameraFor(drag.view))
    const point = drag.plane.intersectLine(new THREE.Line3(raycaster.ray.origin, raycaster.ray.origin.clone().add(raycaster.ray.direction.multiplyScalar(100000))), new THREE.Vector3())
    if (!point) return
    const delta = point.sub(drag.startWorld)
    const startQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      drag.startRotation.x,
      drag.startRotation.y,
      drag.startRotation.z,
      'XYZ',
    ))
    const worldU = new THREE.Vector3()
    worldU[spec.u] = 1
    worldU.applyQuaternion(startQuaternion).normalize()
    const worldV = new THREE.Vector3()
    worldV[spec.v] = 1
    worldV.applyQuaternion(startQuaternion).normalize()
    if (drag.kind === 'move') {
      const localDelta = new THREE.Vector3(
        delta.dot(worldU),
        delta.dot(worldV),
        0,
      )
      const change = { position: {
        x: drag.startPosition.x + worldU.x * localDelta.x + worldV.x * localDelta.y,
        y: drag.startPosition.y + worldU.y * localDelta.x + worldV.y * localDelta.y,
        z: drag.startPosition.z + worldU.z * localDelta.x + worldV.z * localDelta.y,
      } }
      drag.change = change
      this.applyBoxPreview(change)
      return
    }
    const position = { ...drag.startPosition }
    const scale = { ...drag.startScale }
    for (const [axis, sign] of [[spec.u, drag.direction.u], [spec.v, drag.direction.v]] as const) {
      if (!sign) continue
      const worldAxis = axis === spec.u ? worldU : worldV
      const amount = delta.dot(worldAxis) * sign
      const nextScale = Math.max(0.05, drag.startScale[axis] + amount * 2)
      // Use the clamped amount for the center shift as well.  Otherwise a
      // drag past zero would move the box farther than its visible edge.
      const actualAmount = (nextScale - drag.startScale[axis]) * 0.5
      scale[axis] = nextScale
      position.x += worldAxis.x * actualAmount * sign
      position.y += worldAxis.y * actualAmount * sign
      position.z += worldAxis.z * actualAmount * sign
    }
    drag.change = { position, scale }
    this.applyBoxPreview(drag.change)
  }

  private handleControlPointerUp = () => {
    const drag = this.controlDrag
    const boxId = this.selectedBoxModel ? String(this.selectedBoxModel.obj_id) : null
    if (!drag) return
    this.controlDrag = null
    window.removeEventListener('pointermove', this.handleControlPointerMove)
    window.removeEventListener('pointerup', this.handleControlPointerUp)
    this.editorCanvas.style.cursor = ''
    this.previewBox = null
    if (boxId && Object.keys(drag.change).length) this.onTransform(boxId, drag.change)
    if (this.selectedBoxModel) this.focusEditorBox(this.selectedBoxModel)
    this.onMoveEnd()
  }

  private createRenderer(canvas: HTMLCanvasElement, transparent = false) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: transparent, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0x0b1220, transparent ? 0 : 1)
    return renderer
  }

  private cloneBox(box: LabelBox): LabelBox {
    return {
      ...box,
      psr: {
        position: { ...box.psr.position },
        scale: { ...box.psr.scale },
        rotation: { ...box.psr.rotation },
      },
    }
  }

  /**
   * SUST keeps pointer-move work inside the projective editor and commits the
   * annotation once on mouse-up. Doing the same here avoids Vue rebuilding all
   * boxes and re-cropping the local point cloud for every pointer event.
   */
  private applyBoxPreview(change: BoxTransformChange) {
    if (!this.previewBox) return
    if (change.position) this.previewBox.psr.position = { ...change.position }
    if (change.scale) this.previewBox.psr.scale = { ...change.scale }
    if (change.rotation) this.previewBox.psr.rotation = { ...change.rotation }
    const id = String(this.previewBox.obj_id)
    const group = this.boxGroup.children.find((child) => String(child.userData.boxId) === id)
    if (!group) return
    const { position, scale, rotation } = this.previewBox.psr
    group.position.set(position.x, position.y, position.z)
    group.scale.set(scale.x, scale.y, scale.z)
    group.rotation.set(rotation.x, rotation.y, rotation.z)
  }

  private disposeObject(object: THREE.Object3D) {
    object.traverse((node) => {
      const drawable = node as THREE.Mesh
      if (drawable.geometry) drawable.geometry.dispose()
      if (drawable.material) {
        if (Array.isArray(drawable.material)) drawable.material.forEach((material) => material.dispose())
        else drawable.material.dispose()
      }
    })
  }

  private addBox(box: LabelBox) {
    const group = new THREE.Group()
    const id = String(box.obj_id)
    const classConfig = this.classes.get(box.obj_type)
    const color = new THREE.Color(classConfig?.color ?? '#94A3B8')
    const selected = id === this.selectedId
    const lineMaterial = new THREE.LineBasicMaterial({ color: selected ? 0xfde047 : color, transparent: true, opacity: 0.95 })
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), lineMaterial)
    // Match SUST's cuboid convention: a short line projects from the centre of
    // the local +X face so every 3D box has an unambiguous heading indicator.
    const directionGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0.5, 0, 0.5),
      new THREE.Vector3(0.75, 0, 0.5),
    ])
    const directionLine = new THREE.LineSegments(directionGeometry, lineMaterial)
    const pickMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.01, depthWrite: false })
    const pickMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), pickMaterial)
    group.add(edges, directionLine, pickMesh)
    group.userData.boxId = id
    if (selected) {
      group.layers.enable(1)
      edges.layers.enable(1)
      directionLine.layers.enable(1)
      pickMesh.layers.enable(1)
    }
    group.position.set(box.psr.position.x, box.psr.position.y, box.psr.position.z)
    group.rotation.set(box.psr.rotation.x, box.psr.rotation.y, box.psr.rotation.z)
    group.scale.set(box.psr.scale.x, box.psr.scale.y, box.psr.scale.z)
    this.boxGroup.add(group)
  }

  private addMainBoxLabel(box: LabelBox) {
    const id = String(box.obj_id)
    const label = document.createElement('div')
    label.className = 'main-box-label'
    if (id === this.selectedId) label.classList.add('selected')
    label.dataset.boxId = id
    const type = document.createElement('span')
    type.className = 'main-box-label-type'
    type.textContent = box.obj_type
    const trackId = document.createElement('span')
    trackId.className = 'main-box-label-id'
    trackId.textContent = `#${id}`
    const color = this.classes.get(box.obj_type)?.color ?? '#94A3B8'
    label.style.setProperty('--box-label-color', color)
    label.append(type, trackId)
    label.addEventListener('pointerdown', (event) => event.stopPropagation())
    label.addEventListener('click', (event) => {
      event.stopPropagation()
      this.selectLabelAtPoint(event.clientX, event.clientY, id)
    })
    label.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.selectedId = id
      this.onSelect(id)
      this.onBoxContextMenu(id, event.clientX, event.clientY)
    })
    this.mainOverlay.append(label)
    this.mainBoxLabels.push({
      element: label,
      center: new THREE.Vector3(box.psr.position.x, box.psr.position.y, box.psr.position.z),
    })
  }

  private selectLabelAtPoint(clientX: number, clientY: number, fallbackId: string) {
    // Multiple labels can overlap; elementsFromPoint returns them top-most
    // first. A quick repeat click at the same spot cycles through the stack,
    // making labels hidden underneath others selectable too.
    const stack = (document.elementsFromPoint(clientX, clientY) as HTMLElement[])
      .filter((element) => element.classList.contains('main-box-label') && element.dataset.boxId)
      .map((element) => element.dataset.boxId as string)
    const ids = stack.length ? stack : [fallbackId]
    const key = ids.join('\u0000')
    const now = performance.now()
    const last = this.lastLabelClick
    const repeated = !!last
      && now - last.time < 650
      && Math.hypot(clientX - last.x, clientY - last.y) <= 8
      && last.ids === key
    const index = repeated && last ? (last.index + 1) % ids.length : 0
    const nextId = ids[index]
    this.selectedId = nextId
    this.onSelect(nextId)
    this.lastLabelClick = { x: clientX, y: clientY, time: now, ids: key, index }
  }

  private clearMainBoxLabels() {
    for (const { element } of this.mainBoxLabels) element.remove()
    this.mainBoxLabels = []
  }

  private updateMainBoxLabels() {
    const width = Math.max(1, this.mainCanvas.clientWidth)
    const height = Math.max(1, this.mainCanvas.clientHeight)
    const camera = this.activeMainCamera()
    for (const { element, center } of this.mainBoxLabels) {
      const projected = center.clone().project(camera)
      const visible = projected.z >= -1 && projected.z <= 1
        && projected.x >= -1 && projected.x <= 1
        && projected.y >= -1 && projected.y <= 1
      element.hidden = !visible
      if (!visible) continue
      element.style.left = `${(projected.x + 1) * 0.5 * width}px`
      element.style.top = `${(1 - projected.y) * 0.5 * height}px`
    }
  }

  private updateEditorPointCloud() {
    if (this.editorPoints) {
      this.pointGroup.remove(this.editorPoints)
      this.disposeObject(this.editorPoints)
      this.editorPoints = null
    }
    if (!this.pointData || !this.selectedBoxModel) return

    const positions = this.pointData.positions
    const box = this.selectedBoxModel
    const center = new THREE.Vector3(box.psr.position.x, box.psr.position.y, box.psr.position.z)
    const inverseRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      box.psr.rotation.x,
      box.psr.rotation.y,
      box.psr.rotation.z,
      'XYZ',
    )).invert()
    // SUST renders each orthographic subview with a 1.5x planar range and a
    // 3x depth range. Keep a 3x oriented context volume here; each camera's
    // 1.5x frustum then naturally limits the two visible axes while retaining
    // nearby points in the view direction.
    const contextHalfScale = {
      x: Math.abs(box.psr.scale.x) * 0.5 * EDITOR_CONTEXT_DEPTH_RATIO,
      y: Math.abs(box.psr.scale.y) * 0.5 * EDITOR_CONTEXT_DEPTH_RATIO,
      z: Math.abs(box.psr.scale.z) * 0.5 * EDITOR_CONTEXT_DEPTH_RATIO,
    }
    const colors = this.colorMode === 'uniform' ? null : this.makeColors(this.pointData)
    const local = new THREE.Vector3()
    const selectedPositions: number[] = []
    const selectedColors: number[] = []
    for (let index = 0; index < positions.length / 3; index += 1) {
      local.set(
        positions[index * 3] - center.x,
        positions[index * 3 + 1] - center.y,
        positions[index * 3 + 2] - center.z,
      ).applyQuaternion(inverseRotation)
      if (
        Math.abs(local.x) > contextHalfScale.x + 1e-4
        || Math.abs(local.y) > contextHalfScale.y + 1e-4
        || Math.abs(local.z) > contextHalfScale.z + 1e-4
      ) continue
      selectedPositions.push(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2])
      if (colors) selectedColors.push(colors[index * 3], colors[index * 3 + 1], colors[index * 3 + 2])
    }
    if (!selectedPositions.length) return

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(selectedPositions, 3))
    if (colors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(selectedColors, 3))
    geometry.computeBoundingSphere()
    const material = new THREE.PointsMaterial({
      size: this.pointSize,
      sizeAttenuation: false,
      color: colors ? 0xffffff : 0x9ec5ff,
      vertexColors: Boolean(colors),
    })
    this.editorPoints = new THREE.Points(geometry, material)
    this.editorPoints.name = 'selected-box-points'
    this.editorPoints.layers.set(1)
    this.pointGroup.add(this.editorPoints)
  }

  private makeColors(data: PointFrame) {
    const colors = new Float32Array(data.positions.length)
    let minZ = Number.POSITIVE_INFINITY
    let maxZ = Number.NEGATIVE_INFINITY
    if (this.colorMode === 'height') {
      for (let i = 2; i < data.positions.length; i += 3) {
        minZ = Math.min(minZ, data.positions[i])
        maxZ = Math.max(maxZ, data.positions[i])
      }
    }
    for (let i = 0; i < data.intensities.length; i += 1) {
      const value = this.colorMode === 'height'
        ? (data.positions[i * 3 + 2] - minZ) / Math.max(0.001, maxZ - minZ)
        : Math.max(0, Math.min(1, data.intensities[i] / 255))
      const paletteIndex = Math.max(0, Math.min(255, Math.round(value * 255))) * 3
      colors[i * 3] = POINT_COLOR_LUT[paletteIndex]
      colors[i * 3 + 1] = POINT_COLOR_LUT[paletteIndex + 1]
      colors[i * 3 + 2] = POINT_COLOR_LUT[paletteIndex + 2]
    }
    return colors
  }

  private fitToPoints(positions: Float32Array) {
    if (!positions.length) return
    const attribute = new THREE.BufferAttribute(positions, 3)
    const bounds = new THREE.Box3().setFromBufferAttribute(attribute)
    const sphere = bounds.getBoundingSphere(new THREE.Sphere())
    if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) return
    const direction = this.mainCamera.position.clone().sub(this.controls.target)
    if (direction.lengthSq() < 1e-6) direction.set(0, -0.0002, 1)
    else direction.normalize()
    const verticalHalfFov = THREE.MathUtils.degToRad(this.mainCamera.fov * 0.5)
    const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * Math.max(this.mainCamera.aspect, 0.1))
    const halfFov = Math.max(0.01, Math.min(verticalHalfFov, horizontalHalfFov))
    const distance = sphere.radius * 1.25 / Math.sin(halfFov)

    this.controls.target.copy(sphere.center)
    this.mainCamera.position.copy(sphere.center).add(direction.multiplyScalar(distance))
    this.mainCamera.up.set(0, 0, 1)
    this.mainCamera.zoom = 1
    this.mainCamera.near = Math.max(0.1, distance - sphere.radius * 2.5)
    this.mainCamera.far = Math.max(500, distance + sphere.radius * 2.5)
    this.mainCamera.updateProjectionMatrix()
    this.controls.update()
  }

  private setOrthoCenter(
    camera: THREE.OrthographicCamera,
    center: THREE.Vector3,
    radius: number,
    view: Exclude<ViewName, 'main'>,
    box?: LabelBox,
  ) {
    if (box) {
      const spec = this.viewAxisSpec(view)
      const boxQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        box.psr.rotation.x,
        box.psr.rotation.y,
        box.psr.rotation.z,
        'XYZ',
      ))
      const normal = spec.normal.clone().applyQuaternion(boxQuaternion).normalize()
      const up = new THREE.Vector3()
      up[spec.v] = 1
      up.applyQuaternion(boxQuaternion).normalize()
      // Match SUST's front/end convention: look towards the box from the
      // negative local normal for FRONT/SIDE, and from positive local Z for
      // BEV.  The up vector is always the box's local second face axis.
      const facing = view === 'bev' ? 1 : -1
      const distance = Math.max(10, radius * 4)
      camera.position.copy(center).addScaledVector(normal, facing * distance)
      camera.up.copy(up)
      camera.lookAt(center)
      camera.near = 0.1
      camera.far = Math.max(1000, distance * 4)
      camera.updateProjectionMatrix()
      return
    }
    if (view === 'bev') {
      camera.position.set(center.x, center.y, center.z + radius * 3)
      camera.up.set(0, 1, 0)
    }
    if (view === 'front') {
      camera.position.set(center.x, center.y - radius * 3, center.z)
      camera.up.set(0, 0, 1)
    }
    if (view === 'side') {
      camera.position.set(center.x + radius * 3, center.y, center.z)
      camera.up.set(0, 0, 1)
    }
    camera.lookAt(center)
    camera.zoom = 1
    camera.updateProjectionMatrix()
  }

  private focusEditorBox(box: LabelBox) {
    const center = new THREE.Vector3(box.psr.position.x, box.psr.position.y, box.psr.position.z)
    for (const [camera, view] of [
      [this.bevCamera, 'bev'],
      [this.frontCamera, 'front'],
      [this.sideCamera, 'side'],
    ] as const) {
      const spec = this.viewAxisSpec(view)
      const viewport = this.editorViewports[view]
      const aspect = viewport.width / Math.max(1, viewport.height)
      const width = Math.abs(box.psr.scale[spec.u])
      const height = Math.abs(box.psr.scale[spec.v])
      // Match SUST's subview framing: the limiting box dimension occupies
      // about two thirds of the viewport, leaving enough room to see context.
      const viewHeight = Math.max(
        0.5,
        height * EDITOR_BOX_RANGE_RATIO,
        width * EDITOR_BOX_RANGE_RATIO / Math.max(0.1, aspect),
      )
      const extent = Math.max(width, height, 1)
      this.setOrthoCenter(camera, center, extent, view, box)
      // updateOrtho creates a [-100, 100] base frustum (200 units high).
      camera.zoom = 200 / viewHeight
      camera.updateProjectionMatrix()
    }
  }

  private updateOrtho(camera: THREE.OrthographicCamera, viewport: Viewport, baseHeight: number) {
    const aspect = viewport.width / Math.max(1, viewport.height)
    camera.left = -baseHeight * aspect
    camera.right = baseHeight * aspect
    camera.top = baseHeight
    camera.bottom = -baseHeight
    camera.updateProjectionMatrix()
  }

  private activeMainCamera() {
    return this.boxCreationMode ? this.boxCreationCamera : this.mainCamera
  }

  private configureBoxCreationCamera() {
    const bounds = this.pointBounds
      ?? new THREE.Sphere(this.controls.target.clone(), Math.max(10, this.mainCamera.position.distanceTo(this.controls.target) * 0.25))
    // Keep the magnification and focus point the user established before
    // entering creation mode. For a perspective camera, the visible vertical
    // half-height at the orbit target is distance * tan(effectiveFov / 2),
    // which maps directly to the orthographic camera's half-height.
    const center = this.controls.target.clone()
    const radius = Math.max(1, bounds.radius)
    const focusDistance = Math.max(0.1, this.mainCamera.position.distanceTo(this.controls.target))
    const effectiveFov = THREE.MathUtils.degToRad(this.mainCamera.getEffectiveFOV())
    this.boxCreationHalfHeight = Math.max(0.1, focusDistance * Math.tan(effectiveFov * 0.5))
    this.updateOrtho(this.boxCreationCamera, this.mainViewport, this.boxCreationHalfHeight)

    const distance = Math.max(10, radius * 4)
    this.boxCreationCamera.position.set(center.x, center.y, center.z + distance)
    // Preserve the user's orbit yaw when flattening the perspective view into
    // BEV. The horizontal direction from the camera towards its target is the
    // perspective view's ground-plane heading, so using it as orthographic
    // screen-up keeps objects pointing in the same on-screen direction.
    const screenUp = center.clone().sub(this.mainCamera.position)
    screenUp.z = 0
    if (screenUp.lengthSq() < 1e-8) {
      // OrbitControls normally keeps a tiny polar offset even at TOP. Keep a
      // quaternion fallback for programmatic cameras that are exactly vertical.
      screenUp.set(0, 1, 0).applyQuaternion(this.mainCamera.quaternion)
      screenUp.z = 0
    }
    if (screenUp.lengthSq() < 1e-8) screenUp.set(1, 0, 0)
    else screenUp.normalize()
    this.boxCreationCamera.up.copy(screenUp)
    this.boxCreationCamera.lookAt(center)
    this.boxCreationCamera.near = 0.1
    this.boxCreationCamera.far = Math.max(1000, distance + radius * 4)
    this.boxCreationCamera.updateProjectionMatrix()
  }

  private cameraFor(view: Exclude<ViewName, 'main'>) {
    if (view === 'bev') return this.bevCamera
    if (view === 'front') return this.frontCamera
    return this.sideCamera
  }

  private boxIdsFromRay(ray: THREE.Ray, layer: number) {
    const raycaster = new THREE.Raycaster(ray.origin, ray.direction)
    raycaster.layers.set(layer)
    const hits = raycaster.intersectObjects(this.boxGroup.children, true)
    const ids: string[] = []
    for (const hit of hits) {
      let group: THREE.Object3D | undefined = hit.object
      while (group && !group.userData.boxId) group = group.parent ?? undefined
      if (!group?.userData.boxId) continue
      const id = String(group.userData.boxId)
      if (!ids.includes(id)) ids.push(id)
    }
    return ids
  }

  private selectFromRay(ray: THREE.Ray, layer: number) {
    const id = this.boxIdsFromRay(ray, layer)[0] ?? null
    this.selectedId = id
    this.onSelect(id)
    return id
  }

  private pointerNdc(canvas: HTMLCanvasElement, event: PointerEvent, viewport: Viewport) {
    const rect = canvas.getBoundingClientRect()
    const x = event.clientX - rect.left
    const yTop = event.clientY - rect.top
    const yBottom = rect.height - yTop
    const xLocal = x - viewport.x
    const yLocal = yBottom - viewport.y
    return new THREE.Vector2((xLocal / Math.max(1, viewport.width)) * 2 - 1, (yLocal / Math.max(1, viewport.height)) * 2 - 1)
  }

  private mainViewProjection(camera = this.activeMainCamera()) {
    camera.updateMatrixWorld(true)
    return new THREE.Matrix4()
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .elements.slice()
  }

  private worldOnGround(ndc: THREE.Vector2, camera = this.activeMainCamera()) {
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, camera)
    const ground = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
    return raycaster.ray.intersectPlane(ground, new THREE.Vector3())
  }

  private editorPointer(event: PointerEvent): { view: Exclude<ViewName, 'main'>; ndc: THREE.Vector2 } | null {
    const rect = this.editorCanvas.getBoundingClientRect()
    const yTop = event.clientY - rect.top
    if (yTop < rect.height / 3) return { view: 'bev', ndc: this.pointerNdc(this.editorCanvas, event, this.editorViewports.bev) }
    if (yTop < (rect.height * 2) / 3) return { view: 'front', ndc: this.pointerNdc(this.editorCanvas, event, this.editorViewports.front) }
    return { view: 'side', ndc: this.pointerNdc(this.editorCanvas, event, this.editorViewports.side) }
  }

  private handleMainPointerDown = (event: PointerEvent) => {
    if (this.boxCreationMode) {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const rect = this.mainCanvas.getBoundingClientRect()
      this.boxDrawState = {
        pointerId: event.pointerId,
        startClient: { x: event.clientX - rect.left, y: event.clientY - rect.top },
        startNdc: this.pointerNdc(this.mainCanvas, event, this.mainViewport),
      }
      this.mainCanvas.setPointerCapture(event.pointerId)
      this.boxSelectionRect.hidden = false
      this.updateBoxSelectionRect(this.boxDrawState.startClient, this.boxDrawState.startClient)
      return
    }
  }

  private updateBoxSelectionRect(start: { x: number; y: number }, end: { x: number; y: number }) {
    this.boxSelectionRect.style.left = `${Math.min(start.x, end.x)}px`
    this.boxSelectionRect.style.top = `${Math.min(start.y, end.y)}px`
    this.boxSelectionRect.style.width = `${Math.abs(end.x - start.x)}px`
    this.boxSelectionRect.style.height = `${Math.abs(end.y - start.y)}px`
  }

  private handleMainPointerMove = (event: PointerEvent) => {
    const draw = this.boxDrawState
    if (draw && draw.pointerId === event.pointerId) {
      const rect = this.mainCanvas.getBoundingClientRect()
      this.updateBoxSelectionRect(draw.startClient, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      })
      return
    }
  }

  private handleMainPointerUp = (event: PointerEvent) => {
    const draw = this.boxDrawState
    if (draw && draw.pointerId === event.pointerId) {
      const rect = this.mainCanvas.getBoundingClientRect()
      const endClient = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      const width = Math.abs(endClient.x - draw.startClient.x)
      const height = Math.abs(endClient.y - draw.startClient.y)
      this.boxDrawState = null
      this.boxSelectionRect.hidden = true
      if (this.mainCanvas.hasPointerCapture(event.pointerId)) this.mainCanvas.releasePointerCapture(event.pointerId)
      if (width < 4 || height < 4) return

      const camera = this.activeMainCamera()
      const endNdc = this.pointerNdc(this.mainCanvas, event, this.mainViewport)
      const worldStart = this.worldOnGround(draw.startNdc, camera)
      const worldEnd = this.worldOnGround(endNdc, camera)
      if (!worldStart || !worldEnd) return
      const viewProjMatrix = this.mainViewProjection(camera)
      this.setBoxCreationMode(false)
      this.onCreateRegion({
        projectRect: [
          { x: draw.startNdc.x, y: draw.startNdc.y },
          { x: endNdc.x, y: endNdc.y },
        ],
        viewProjMatrix,
        headAngle: Math.atan2(worldEnd.y - worldStart.y, worldEnd.x - worldStart.x),
        worldCenter: {
          x: (worldStart.x + worldEnd.x) * 0.5,
          y: (worldStart.y + worldEnd.y) * 0.5,
          z: 0,
        },
      })
      return
    }
  }

  private handleMainPointerCancel = (event: PointerEvent) => {
    if (this.boxDrawState?.pointerId !== event.pointerId) return
    this.boxDrawState = null
    this.boxSelectionRect.hidden = true
  }

  private handleMainContextMenu = (event: MouseEvent) => {
    event.preventDefault()
    // Main-view selection and object menus are intentionally label-only.
    // The wireframes frequently overlap in dense scenes and are too ambiguous
    // to use as a reliable pointer target.
  }

  private handleEditorPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    const pointer = this.editorPointer(event)
    if (!pointer) return
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(pointer.ndc, this.cameraFor(pointer.view))
    const id = this.selectFromRay(raycaster.ray, 1)
    if (!id) return
    const selected = this.boxGroup.children.find((child) => child.userData.boxId === id)
    if (!selected) return
    const spec = this.viewAxisSpec(pointer.view)
    const box = this.selectedBoxModel
    const quaternion = box
      ? new THREE.Quaternion().setFromEuler(new THREE.Euler(box.psr.rotation.x, box.psr.rotation.y, box.psr.rotation.z, 'XYZ'))
      : new THREE.Quaternion()
    const normal = spec.normal.clone().applyQuaternion(quaternion).normalize()
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, selected.position)
    const startPoint = plane.intersectLine(new THREE.Line3(raycaster.ray.origin, raycaster.ray.origin.clone().add(raycaster.ray.direction.multiplyScalar(100000))), new THREE.Vector3())
    if (!startPoint) return
    event.preventDefault()
    this.previewBox = box ? this.cloneBox(box) : null
    this.dragState = {
      view: pointer.view,
      boxId: id,
      pointerId: event.pointerId,
      plane,
      startPoint,
      startPosition: selected.position.clone(),
      change: {},
    }
    this.editorCanvas.setPointerCapture(event.pointerId)
  }

  private handleEditorPointerMove = (event: PointerEvent) => {
    if (!this.dragState || this.dragState.pointerId !== event.pointerId) return
    const raycaster = new THREE.Raycaster()
    const ndc = this.pointerNdc(this.editorCanvas, event, this.editorViewports[this.dragState.view])
    raycaster.setFromCamera(ndc, this.cameraFor(this.dragState.view))
    const line = new THREE.Line3(raycaster.ray.origin, raycaster.ray.origin.clone().add(raycaster.ray.direction.multiplyScalar(100000)))
    const point = this.dragState.plane.intersectLine(line, new THREE.Vector3())
    if (!point) return
    const delta = point.sub(this.dragState.startPoint)
    const position = this.dragState.startPosition.clone()
    const spec = this.viewAxisSpec(this.dragState.view)
    const box = this.selectedBoxModel
    const quaternion = box
      ? new THREE.Quaternion().setFromEuler(new THREE.Euler(box.psr.rotation.x, box.psr.rotation.y, box.psr.rotation.z, 'XYZ'))
      : new THREE.Quaternion()
    const worldU = new THREE.Vector3()
    worldU[spec.u] = 1
    worldU.applyQuaternion(quaternion).normalize()
    const worldV = new THREE.Vector3()
    worldV[spec.v] = 1
    worldV.applyQuaternion(quaternion).normalize()
    position.addScaledVector(worldU, delta.dot(worldU)).addScaledVector(worldV, delta.dot(worldV))
    this.dragState.change = { position: { x: position.x, y: position.y, z: position.z } }
    this.applyBoxPreview(this.dragState.change)
  }

  private handlePointerUp = (event: PointerEvent) => {
    const drag = this.dragState
    if (!drag || drag.pointerId !== event.pointerId) return
    if (this.editorCanvas.hasPointerCapture(event.pointerId)) this.editorCanvas.releasePointerCapture(event.pointerId)
    this.dragState = null
    this.previewBox = null
    if (Object.keys(drag.change).length) this.onTransform(drag.boxId, drag.change)
    if (this.selectedBoxModel) this.focusEditorBox(this.selectedBoxModel)
    this.onMoveEnd()
  }
}
