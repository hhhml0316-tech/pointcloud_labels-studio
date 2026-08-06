import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { ClassConfig, LabelBox, PointFrame, Vec3 } from '../types'

export type ViewName = 'main' | 'bev' | 'front' | 'side'

type Viewport = { x: number; y: number; width: number; height: number }

type DragState = {
  view: Exclude<ViewName, 'main'>
  boxId: string
  plane: THREE.Plane
  startPoint: THREE.Vector3
  startPosition: THREE.Vector3
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

const EDITOR_BOX_RANGE_RATIO = 1.5
const EDITOR_CONTEXT_DEPTH_RATIO = 3
const MAIN_VIEW_FILL_RATIO = 0.82

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
  private readonly mainCamera = new THREE.PerspectiveCamera(55, 1, 0.1, 10000)
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

  constructor(
    mainCanvas: HTMLCanvasElement,
    mainOverlay: HTMLDivElement,
    editorCanvas: HTMLCanvasElement,
    editorOverlay: HTMLDivElement,
    private readonly onSelect: (id: string | null) => void,
    private readonly onTransform: (id: string, change: BoxTransformChange) => void,
    private readonly onMoveEnd: () => void,
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
    this.scene.add(this.pointGroup, this.boxGroup)
    this.scene.add(new THREE.AmbientLight(0xffffff, 1))
    this.scene.add(new THREE.AxesHelper(5))

    this.controls = new OrbitControls(this.mainCamera, mainCanvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.screenSpacePanning = true
    this.controls.enableRotate = true

    this.mainCanvas.addEventListener('pointerdown', this.handleMainPointerDown)
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
    if (this.shouldFitMainView) {
      this.fitToPoints(data.positions)
      this.shouldFitMainView = false
    }
    this.updateEditorPointCloud()
    if (this.selectedBoxModel) this.focusEditorBox(this.selectedBoxModel)
  }

  setBoxes(boxes: LabelBox[], selectedId: string | null) {
    this.selectedId = selectedId
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
    this.mainOverlay.replaceChildren()
    this.mainBoxLabels = []
    boxes.forEach((box) => {
      this.addBox(box)
      this.addMainBoxLabel(box)
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
    this.mainRenderer.render(this.scene, this.mainCamera)
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
    this.layoutEditorOverlay(editorWidth, editorHeight)
  }

  dispose() {
    this.mainCanvas.removeEventListener('pointerdown', this.handleMainPointerDown)
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
        handle.setAttribute('width', '10')
        handle.setAttribute('height', '10')
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
    if (view === 'bev') return { u: 'x', v: 'y', rotation: 'z', normal: new THREE.Vector3(0, 0, 1) }
    if (view === 'front') return { u: 'x', v: 'z', rotation: 'y', normal: new THREE.Vector3(0, 1, 0) }
    return { u: 'y', v: 'z', rotation: 'x', normal: new THREE.Vector3(1, 0, 0) }
  }

  private screenAxisSigns(view: Exclude<ViewName, 'main'>) {
    // With the SUST front/end convention, SIDE looks along +X, therefore
    // local +Y appears on the screen's left.  The other two views preserve
    // local +U as screen-right.
    return { u: view === 'side' ? -1 : 1, v: 1 }
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
    if (!this.selectedBoxModel) return null
    const box = this.selectedBoxModel
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
      element.setAttribute('x', `${point.x - 6}`)
      element.setAttribute('y', `${point.y - 6}`)
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
      const rotationHandle = {
        x: top.x + direction.x / directionLength * 28,
        y: top.y + direction.y / directionLength * 28,
      }
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
    }
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
      this.onTransform(String(box.obj_id), { rotation })
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
      this.onTransform(String(box.obj_id), { position: {
        x: drag.startPosition.x + worldU.x * localDelta.x + worldV.x * localDelta.y,
        y: drag.startPosition.y + worldU.y * localDelta.x + worldV.y * localDelta.y,
        z: drag.startPosition.z + worldU.z * localDelta.x + worldV.z * localDelta.y,
      } })
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
    this.onTransform(String(box.obj_id), { position, scale })
  }

  private handleControlPointerUp = () => {
    if (!this.controlDrag) return
    this.controlDrag = null
    window.removeEventListener('pointermove', this.handleControlPointerMove)
    window.removeEventListener('pointerup', this.handleControlPointerUp)
    this.editorCanvas.style.cursor = ''
    if (this.selectedBoxModel) this.focusEditorBox(this.selectedBoxModel)
    this.onMoveEnd()
  }

  private createRenderer(canvas: HTMLCanvasElement, transparent = false) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: transparent, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0x0b1220, transparent ? 0 : 1)
    return renderer
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
    const pickMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.01, depthWrite: false })
    const pickMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), pickMaterial)
    group.add(edges, pickMesh)
    group.userData.boxId = id
    if (selected) {
      group.layers.enable(1)
      edges.layers.enable(1)
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
    this.mainOverlay.append(label)
    this.mainBoxLabels.push({
      element: label,
      center: new THREE.Vector3(box.psr.position.x, box.psr.position.y, box.psr.position.z),
    })
  }

  private updateMainBoxLabels() {
    const width = Math.max(1, this.mainCanvas.clientWidth)
    const height = Math.max(1, this.mainCanvas.clientHeight)
    for (const { element, center } of this.mainBoxLabels) {
      const projected = center.clone().project(this.mainCamera)
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
    const color = new THREE.Color()
    for (let i = 0; i < data.intensities.length; i += 1) {
      const value = this.colorMode === 'height'
        ? (data.positions[i * 3 + 2] - minZ) / Math.max(0.001, maxZ - minZ)
        : Math.max(0, Math.min(1, data.intensities[i] / 255))
      color.setHSL(0.66 - value * 0.66, 0.85, 0.55)
      colors[i * 3] = color.r
      colors[i * 3 + 1] = color.g
      colors[i * 3 + 2] = color.b
    }
    return colors
  }

  private fitToPoints(positions: Float32Array) {
    if (!positions.length) return
    const attribute = new THREE.BufferAttribute(positions, 3)
    const bounds = new THREE.Box3().setFromBufferAttribute(attribute)
    const center = bounds.getCenter(new THREE.Vector3())
    const size = bounds.getSize(new THREE.Vector3())
    const verticalHalfFov = THREE.MathUtils.degToRad(this.mainCamera.fov * 0.5)
    const tangent = Math.max(0.01, Math.tan(verticalHalfFov))
    const aspect = Math.max(0.1, this.mainCamera.aspect)
    const halfWidth = Math.max(0.5, size.x * 0.5)
    const halfHeight = Math.max(0.5, size.y * 0.5)
    const fitDistance = Math.max(
      halfHeight / tangent,
      halfWidth / (tangent * aspect),
    ) / MAIN_VIEW_FILL_RATIO
    const distance = Math.max(fitDistance, size.z + 1)

    this.mainCamera.position.set(center.x, center.y, center.z + distance)
    this.mainCamera.up.set(0, 1, 0)
    this.mainCamera.lookAt(center)
    this.mainCamera.zoom = 1
    this.mainCamera.near = 0.1
    this.mainCamera.far = Math.max(10000, distance + size.z + 100)
    this.mainCamera.updateProjectionMatrix()
    this.controls.target.copy(center)
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

  private cameraFor(view: Exclude<ViewName, 'main'>) {
    if (view === 'bev') return this.bevCamera
    if (view === 'front') return this.frontCamera
    return this.sideCamera
  }

  private selectFromRay(ray: THREE.Ray, layer: number) {
    const raycaster = new THREE.Raycaster(ray.origin, ray.direction)
    raycaster.layers.set(layer)
    const hits = raycaster.intersectObjects(this.boxGroup.children, true)
    const hit = hits.find((item) => item.object.parent?.userData.boxId || item.object.userData.boxId)
    let group: THREE.Object3D | undefined
    if (hit) {
      group = hit.object
      while (group && !group.userData.boxId) group = group.parent ?? undefined
    }
    const id = group?.userData.boxId ? String(group.userData.boxId) : null
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

  private editorPointer(event: PointerEvent): { view: Exclude<ViewName, 'main'>; ndc: THREE.Vector2 } | null {
    const rect = this.editorCanvas.getBoundingClientRect()
    const yTop = event.clientY - rect.top
    if (yTop < rect.height / 3) return { view: 'bev', ndc: this.pointerNdc(this.editorCanvas, event, this.editorViewports.bev) }
    if (yTop < (rect.height * 2) / 3) return { view: 'front', ndc: this.pointerNdc(this.editorCanvas, event, this.editorViewports.front) }
    return { view: 'side', ndc: this.pointerNdc(this.editorCanvas, event, this.editorViewports.side) }
  }

  private handleMainPointerDown = (event: PointerEvent) => {
    const ndc = this.pointerNdc(this.mainCanvas, event, this.mainViewport)
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, this.mainCamera)
    this.selectFromRay(raycaster.ray, 0)
  }

  private handleEditorPointerDown = (event: PointerEvent) => {
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
    this.dragState = { view: pointer.view, boxId: id, plane, startPoint, startPosition: selected.position.clone() }
    this.editorCanvas.setPointerCapture(event.pointerId)
  }

  private handleEditorPointerMove = (event: PointerEvent) => {
    if (!this.dragState) return
    const pointer = this.editorPointer(event)
    if (!pointer) return
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(pointer.ndc, this.cameraFor(this.dragState.view))
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
    const group = this.boxGroup.children.find((child) => child.userData.boxId === this.dragState?.boxId)
    if (group) group.position.copy(position)
    this.onTransform(this.dragState.boxId, { position: { x: position.x, y: position.y, z: position.z } })
  }

  private handlePointerUp = () => {
    if (this.dragState) this.onMoveEnd()
    this.dragState = null
    if (this.selectedBoxModel) this.focusEditorBox(this.selectedBoxModel)
  }
}
