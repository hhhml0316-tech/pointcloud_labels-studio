<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { AIBoxFitter } from './ai-box/index.js'
import { createAIBoxConfig, DEFAULT_AI_BOX_CONFIG } from './ai-box/config.js'
import { api, PointWorkerClient } from './api'
import { PointFrameCache } from './pointCache'
import { SceneManager } from './render/SceneManager'
import type { AIBoxConfig, AIBoxFitResult, AIBoxSelection, ClassConfig, FrameInfo, LabelBox, PointFrame, SequenceInfo, Vec3 } from './types'

type NumericSection = 'position' | 'scale' | 'rotation'
type Axis = 'x' | 'y' | 'z'
type AIConfigNumberPath =
  | Exclude<keyof AIBoxConfig, 'enabled' | 'heightRange' | 'enableDenoise' | 'angleSearch' | 'preferLongEdgeAsX' | 'useHeadAngle' | 'useWorker'>
  | `angleSearch.${keyof AIBoxConfig['angleSearch']}`

type AIConfigNumberField = {
  path: AIConfigNumberPath
  label: string
  step: number
  min?: number
  max?: number
  optional?: boolean
}

const mainCanvas = ref<HTMLCanvasElement | null>(null)
const mainOverlay = ref<HTMLDivElement | null>(null)
const editorCanvas = ref<HTMLCanvasElement | null>(null)
const editorOverlay = ref<HTMLDivElement | null>(null)
const sequences = ref<SequenceInfo[]>([])
const frames = ref<FrameInfo[]>([])
const classes = ref<ClassConfig[]>([])
const sequenceId = ref('')
const frameIndex = ref(0)
const boxes = ref<LabelBox[]>([])
const points = ref<PointFrame | null>(null)
const selectedBoxId = ref<string | null>(null)
const pointSize = ref(1.5)
const colorMode = ref<'intensity' | 'uniform' | 'height'>('intensity')
const speed = ref(1)
const isPlaying = ref(false)
const isLoading = ref(false)
const dirty = ref(false)
const labelExists = ref(false)
const warnings = ref<string[]>([])
const notice = ref('')
const errorMessage = ref('')
const undoStack = ref<LabelBox[][]>([])
const redoStack = ref<LabelBox[][]>([])
const pendingNewClass = ref<ClassConfig | null>(null)
const showNewBoxTypes = ref(false)
const isAIFitting = ref(false)
const showAISettings = ref(false)
const isCopyingAdjacent = ref(false)
const aiBoxConfig = ref<AIBoxConfig>(createAIBoxConfig())
const contextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  boxId: '',
  typeOpen: false,
  idEditing: false,
  draftId: '',
})
const numericSections: NumericSection[] = ['position', 'scale', 'rotation']
const axes: Axis[] = ['x', 'y', 'z']
const aiNumberFields: AIConfigNumberField[] = [
  { path: 'minBoxSize', label: '包围框最小边长（m）', step: 0.01, min: 0.001 },
  { path: 'roadGridSize', label: '地面模型网格尺寸（m）', step: 0.1, min: 0.01 },
  { path: 'roadZStatSigmaLow', label: '地面高度统计下界（σ）', step: 0.1, min: 0 },
  { path: 'roadZStatSigmaHigh', label: '地面高度统计上界（σ）', step: 0.1, min: 0 },
  { path: 'roadCellLowestMargin', label: '网格最低点容差（m）', step: 0.05, min: 0 },
  { path: 'roadOutlierK', label: '地面离群检测邻点数（K）', step: 1, min: 1 },
  { path: 'roadOutlierStdMul', label: '地面离群阈值（标准差倍数）', step: 0.1 },
  { path: 'roadMaxSlopeDeg', label: '地面最大允许坡度（°）', step: 0.5, min: 0, max: 90 },
  { path: 'roadSlopeSearchMul', label: '坡度检测半径（网格倍数）', step: 1, min: 0 },
  { path: 'roadQueryZOffset', label: '地面查询高度修正（m）', step: 0.01 },
  { path: 'roadGap', label: '包围框底面离地间隙（m）', step: 0.01, min: 0 },
  { path: 'minPointsAfterRoadFilter', label: '地面滤除后最小点数', step: 1, min: 1 },
  { path: 'minFilterPoints', label: '启用聚类去噪的点数阈值', step: 1, min: 1 },
  { path: 'dbscanEps', label: 'DBSCAN 邻域半径（m）', step: 0.05, min: 0.001 },
  { path: 'dbscanMinPts', label: 'DBSCAN 核心点最小邻点数', step: 1, min: 1 },
  { path: 'angleSearch.round1Count', label: '朝向粗搜索采样数', step: 1, min: 2 },
  { path: 'angleSearch.round2Count', label: '朝向精搜索采样数', step: 1, min: 1 },
  { path: 'angleSearch.round3Count', label: '朝向细化搜索采样数', step: 1, min: 1 },
  { path: 'edgeGap', label: '边缘点判定距离（m）', step: 0.05, min: 0.001 },
  { path: 'lossScale', label: '朝向拟合损失权重', step: 1, min: 0 },
  { path: 'headFlipThresholdRad', label: '朝向反转判定阈值（rad）', step: 0.05, min: 0, max: Math.PI },
  { path: 'existingBoxFitPaddingRatio', label: '现有框重拟合区域扩展比例', step: 0.05, min: 0, max: 5 },
  { path: 'maxPointsForFit', label: '单次拟合最大采样点数（留空表示不限）', step: 1000, min: 1, optional: true },
]

let scene: SceneManager | null = null
let worker: PointWorkerClient | null = null
let cache: PointFrameCache | null = null
let aiFitter: AIBoxFitter | null = null
let animationFrame = 0
let playTimer: number | undefined
let inputEditActive = false
let dragEditActive = false
let maxObservedNumericId = 0
let aiOperationSerial = 0

const currentSequence = computed(() => sequences.value.find((item) => item.sequence_id === sequenceId.value))
const currentFrame = computed(() => frames.value[frameIndex.value])
const selectedBox = computed(() => boxes.value.find((box) => String(box.obj_id) === selectedBoxId.value))
const classOptions = computed(() => {
  const values = new Map(classes.value.map((item) => [item.id, item]))
  boxes.value.forEach((box) => {
    if (!values.has(box.obj_type)) values.set(box.obj_type, { id: box.obj_type, label: box.obj_type, color: '#94A3B8', default_size: [4, 2, 1.5] })
  })
  return [...values.values()]
})

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function setNotice(message: string) {
  notice.value = message
  window.setTimeout(() => {
    if (notice.value === message) notice.value = ''
  }, 3200)
}

function setError(error: unknown) {
  errorMessage.value = error instanceof Error ? error.message : String(error)
}

function beginEdit() {
  undoStack.value.push(clone(boxes.value))
  if (undoStack.value.length > 80) undoStack.value.shift()
  redoStack.value = []
  dirty.value = true
}

function beginInputEdit() {
  if (!inputEditActive) {
    inputEditActive = true
    beginEdit()
  }
}

function endInputEdit() {
  inputEditActive = false
}

function beginDragEdit() {
  if (!dragEditActive) {
    dragEditActive = true
    beginEdit()
  }
}

function endDragEdit() {
  dragEditActive = false
}

function undo() {
  const previous = undoStack.value.pop()
  if (!previous) return
  redoStack.value.push(clone(boxes.value))
  boxes.value = clone(previous)
  dirty.value = true
  selectedBoxId.value = null
}

function redo() {
  const next = redoStack.value.pop()
  if (!next) return
  undoStack.value.push(clone(boxes.value))
  boxes.value = clone(next)
  dirty.value = true
  selectedBoxId.value = null
}

async function loadSequences() {
  try {
    const [sequenceValues, classValues, serverAIConfig] = await Promise.all([
      api.sequences(),
      api.classes(),
      api.aiBoxConfig(),
    ])
    sequences.value = sequenceValues
    classes.value = classValues
    aiBoxConfig.value = createAIBoxConfig(serverAIConfig)
    if (sequences.value.length) await loadSequence(sequences.value[0].sequence_id)
  } catch (error) {
    setError(error)
  }
}

async function loadSequence(nextId: string) {
  if (!nextId) return
  if (dirty.value && !window.confirm('当前帧有未保存修改，切换序列将丢弃修改，继续？')) return
  stopPlayback()
  maxObservedNumericId = 0
  try {
    isLoading.value = true
    sequenceId.value = nextId
    frames.value = await api.frames(nextId)
    frameIndex.value = 0
    dirty.value = false
    undoStack.value = []
    redoStack.value = []
    scene?.fitMainViewOnNextFrame()
    await loadFrame(0, true)
  } catch (error) {
    setError(error)
  } finally {
    isLoading.value = false
  }
}

async function loadFrame(nextIndex: number, force = false) {
  if (!frames.value.length || nextIndex < 0 || nextIndex >= frames.value.length) return
  if (!force && dirty.value && !window.confirm('当前帧有未保存修改，切换帧将丢弃修改，继续？')) return
  const frame = frames.value[nextIndex]
  cancelNewBoxCreation()
  closeContextMenu()
  try {
    isLoading.value = true
    errorMessage.value = ''
    const [pointFrame, labels] = await Promise.all([
      cache!.get(sequenceId.value, frame.frame_id),
      api.labels(sequenceId.value, frame.frame_id),
    ])
    frameIndex.value = nextIndex
    points.value = pointFrame
    boxes.value = clone(labels.boxes)
    for (const box of boxes.value) {
      const numericId = Number(box.obj_id)
      if (Number.isInteger(numericId) && numericId >= 0) maxObservedNumericId = Math.max(maxObservedNumericId, numericId)
    }
    warnings.value = labels.warnings
    labelExists.value = labels.label_exists
    selectedBoxId.value = null
    dirty.value = false
    undoStack.value = []
    redoStack.value = []
    // Frame changes only register the source cloud. Ground extraction is lazy
    // (first AI action) and the result is reused for the rest of the sequence.
    aiFitter?.setFrame(frame.frame_id, pointFrame.positions, sequenceId.value)
    const neighborIds = frames.value.slice(Math.max(0, nextIndex - 2), Math.min(frames.value.length, nextIndex + 3)).map((item) => item.frame_id)
    cache!.prefetch(sequenceId.value, neighborIds)
  } catch (error) {
    setError(error)
  } finally {
    isLoading.value = false
  }
}

async function save() {
  if (!currentFrame.value) return
  try {
    isLoading.value = true
    const result = await api.saveLabels(sequenceId.value, currentFrame.value.frame_id, clone(boxes.value))
    dirty.value = false
    labelExists.value = true
    warnings.value = result.warnings
    setNotice(result.backup_file ? `已保存，旧文件备份为 ${result.backup_file}` : '已创建标签文件')
  } catch (error) {
    setError(error)
  } finally {
    isLoading.value = false
  }
}

async function reloadCurrent() {
  await loadFrame(frameIndex.value, true)
}

function stopPlayback() {
  isPlaying.value = false
  if (playTimer !== undefined) window.clearTimeout(playTimer)
  playTimer = undefined
}

function playNext() {
  if (!isPlaying.value) return
  const next = frameIndex.value + 1
  if (next >= frames.value.length) {
    stopPlayback()
    return
  }
  const startedAt = performance.now()
  void loadFrame(next).then(() => {
    if (!isPlaying.value) return
    const interval = 1000 / Math.max(0.1, (currentSequence.value?.frame_rate ?? 10) * speed.value)
    // Loading/decoding is part of the frame interval. Adding a full interval
    // after it made playback slower by exactly every frame's load time.
    const remaining = Math.max(0, interval - (performance.now() - startedAt))
    playTimer = window.setTimeout(playNext, remaining)
  })
}

function togglePlayback() {
  if (isPlaying.value) {
    stopPlayback()
    return
  }
  if (dirty.value && !window.confirm('播放前需要放弃未保存修改，继续？')) return
  dirty.value = false
  isPlaying.value = true
  playNext()
}

function selectBox(id: string | null) {
  selectedBoxId.value = id
}

function transformBox(id: string, change: { position?: Vec3; scale?: Vec3; rotation?: Vec3 }) {
  const box = boxes.value.find((item) => String(item.obj_id) === id)
  if (!box) return
  beginDragEdit()
  if (change.position) box.psr.position = { ...change.position }
  if (change.scale) box.psr.scale = { ...change.scale }
  if (change.rotation) box.psr.rotation = { ...change.rotation }
  dirty.value = true
}

function valueOf(section: NumericSection, axis: Axis) {
  return selectedBox.value?.psr[section][axis] ?? ''
}

function setNumeric(section: NumericSection, axis: Axis, event: Event) {
  const box = selectedBox.value
  if (!box) return
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  beginInputEdit()
  box.psr[section][axis] = value
  dirty.value = true
}

function setCategory(event: Event) {
  const box = selectedBox.value
  if (!box) return
  beginInputEdit()
  box.obj_type = (event.target as HTMLSelectElement).value
  dirty.value = true
}

function setId(event: Event) {
  const box = selectedBox.value
  if (!box) return
  beginInputEdit()
  box.obj_id = (event.target as HTMLInputElement).value
  selectedBoxId.value = String(box.obj_id)
  dirty.value = true
}

function nextObjectId() {
  for (const box of boxes.value) {
    const numericId = Number(box.obj_id)
    if (Number.isInteger(numericId) && numericId >= 0) maxObservedNumericId = Math.max(maxObservedNumericId, numericId)
  }
  maxObservedNumericId += 1
  return String(maxObservedNumericId)
}

function toggleNewBoxTypes() {
  if (isAIFitting.value) return
  showNewBoxTypes.value = !showNewBoxTypes.value
  closeContextMenu()
}

function armNewBoxCreation(config: ClassConfig) {
  pendingNewClass.value = config
  showNewBoxTypes.value = false
  selectedBoxId.value = null
  scene?.setBoxCreationMode(true)
  setNotice(`已选择 ${config.label}，主视图已切换至 BEV；请按住左键拖出目标区域，Esc 取消`)
}

function cancelNewBoxCreation() {
  aiOperationSerial += 1
  isAIFitting.value = false
  pendingNewClass.value = null
  showNewBoxTypes.value = false
  scene?.setBoxCreationMode(false)
}

function standardBoxForSelection(config: ClassConfig, selection: AIBoxSelection, id: string): LabelBox {
  return {
    obj_id: id,
    obj_type: config.id,
    psr: {
      position: {
        x: selection.worldCenter.x,
        y: selection.worldCenter.y,
        z: selection.worldCenter.z + config.default_size[2] / 2,
      },
      scale: {
        x: config.default_size[0],
        y: config.default_size[1],
        z: config.default_size[2],
      },
      rotation: { x: 0, y: 0, z: 0 },
    },
  }
}

async function handleCreateRegion(selection: AIBoxSelection) {
  const classConfig = pendingNewClass.value
  const frameId = currentFrame.value?.frame_id
  if (!classConfig || !frameId) return
  pendingNewClass.value = null
  const operation = ++aiOperationSerial
  isAIFitting.value = true
  let fit: AIBoxFitResult | null = null
  let fallbackReason = ''
  try {
    if (aiBoxConfig.value.enabled && aiFitter) {
      try {
        fit = await aiFitter.fitAIBox({ frameId, ...selection })
        if (!fit) fallbackReason = '选区点数不足或几何拟合失败'
      } catch (error) {
        fallbackReason = error instanceof Error ? error.message : String(error)
      }
    } else {
      fallbackReason = '几何拟合已关闭'
    }
    if (operation !== aiOperationSerial || currentFrame.value?.frame_id !== frameId) return
    const id = nextObjectId()
    const box: LabelBox = fit
      ? {
          obj_id: id,
          obj_type: classConfig.id,
          psr: {
            position: clone(fit.position),
            scale: clone(fit.scale),
            rotation: clone(fit.rotation),
          },
        }
      : standardBoxForSelection(classConfig, selection, id)
    beginEdit()
    boxes.value.push(box)
    selectedBoxId.value = id
    dirty.value = true
    setNotice(fit
      ? `几何拟合完成：${classConfig.label} #${id}`
      : `几何拟合未成功，已在选区生成标准 ${classConfig.label} 框 #${id}${fallbackReason ? `（${fallbackReason}）` : ''}`)
  } finally {
    if (operation === aiOperationSerial) isAIFitting.value = false
  }
}

function openBoxContextMenu(boxId: string, clientX: number, clientY: number) {
  pendingNewClass.value = null
  showNewBoxTypes.value = false
  scene?.setBoxCreationMode(false)
  selectedBoxId.value = boxId
  contextMenu.value = {
    visible: true,
    x: Math.max(8, Math.min(clientX, window.innerWidth - 300)),
    y: Math.max(8, Math.min(clientY, window.innerHeight - 310)),
    boxId,
    typeOpen: false,
    idEditing: false,
    draftId: boxId,
  }
}

function openListContextMenu(boxId: string, event: MouseEvent) {
  event.preventDefault()
  openBoxContextMenu(boxId, event.clientX, event.clientY)
}

function closeContextMenu() {
  contextMenu.value.visible = false
  contextMenu.value.typeOpen = false
  contextMenu.value.idEditing = false
}

function changeContextType(type: string) {
  const box = boxes.value.find((item) => String(item.obj_id) === contextMenu.value.boxId)
  if (!box || box.obj_type === type) {
    closeContextMenu()
    return
  }
  beginEdit()
  box.obj_type = type
  dirty.value = true
  closeContextMenu()
}

function beginContextIdEdit() {
  contextMenu.value.typeOpen = false
  contextMenu.value.idEditing = true
  contextMenu.value.draftId = contextMenu.value.boxId
}

function commitContextId() {
  const oldId = contextMenu.value.boxId
  const box = boxes.value.find((item) => String(item.obj_id) === oldId)
  if (!box) return
  const nextId = contextMenu.value.draftId.trim()
  if (!/^\d+$/.test(nextId)) {
    setError('ID 必须是非负整数')
    return
  }
  if (boxes.value.some((item) => item !== box && String(item.obj_id) === nextId)) {
    setError(`ID ${nextId} 在当前帧中已存在`)
    return
  }
  beginEdit()
  box.obj_id = nextId
  selectedBoxId.value = nextId
  maxObservedNumericId = Math.max(maxObservedNumericId, Number(nextId))
  dirty.value = true
  closeContextMenu()
}

async function refitContextBox() {
  const boxId = contextMenu.value.boxId
  const frameId = currentFrame.value?.frame_id
  const box = boxes.value.find((item) => String(item.obj_id) === boxId)
  closeContextMenu()
  if (!box || !frameId || !aiFitter) return
  if (!aiBoxConfig.value.enabled) {
    setNotice('请先在“拟合参数”中启用几何拟合')
    return
  }
  const selection = scene?.getBoxFitSelection(box, aiBoxConfig.value.existingBoxFitPaddingRatio)
  if (!selection) {
    setNotice('当前视角无法得到该框的拟合区域')
    return
  }
  const operation = ++aiOperationSerial
  isAIFitting.value = true
  try {
    const fit = await aiFitter.fitAIBox({ frameId, ...selection })
    if (operation !== aiOperationSerial || currentFrame.value?.frame_id !== frameId) return
    const target = boxes.value.find((item) => String(item.obj_id) === boxId)
    if (!fit || !target) {
      setNotice('几何拟合失败，原框保持不变')
      return
    }
    beginEdit()
    target.psr = {
      position: clone(fit.position),
      scale: clone(fit.scale),
      rotation: clone(fit.rotation),
    }
    dirty.value = true
    selectedBoxId.value = boxId
    setNotice(`已对标注框 #${boxId} 重新执行几何拟合`)
  } catch (error) {
    if (operation === aiOperationSerial) setError(`几何拟合失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (operation === aiOperationSerial) isAIFitting.value = false
  }
}

function getAIConfigNumber(path: AIConfigNumberPath) {
  if (path.startsWith('angleSearch.')) {
    return aiBoxConfig.value.angleSearch[path.split('.')[1] as keyof AIBoxConfig['angleSearch']]
  }
  return aiBoxConfig.value[path as Exclude<AIConfigNumberPath, `angleSearch.${string}`>] ?? ''
}

function setAIConfigNumber(field: AIConfigNumberField, event: Event) {
  const raw = (event.target as HTMLInputElement).value
  const next = clone(aiBoxConfig.value)
  if (field.optional && raw === '') {
    delete next.maxPointsForFit
  } else {
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    if (field.path.startsWith('angleSearch.')) {
      next.angleSearch[field.path.split('.')[1] as keyof AIBoxConfig['angleSearch']] = value
    } else {
      ;(next as unknown as Record<string, unknown>)[field.path] = value
    }
  }
  aiBoxConfig.value = createAIBoxConfig(next)
}

function setAIConfigBoolean(
  path: 'enabled' | 'enableDenoise' | 'preferLongEdgeAsX' | 'useHeadAngle' | 'useWorker',
  event: Event,
) {
  const next = clone(aiBoxConfig.value)
  next[path] = (event.target as HTMLInputElement).checked
  aiBoxConfig.value = createAIBoxConfig(next)
}

function setHeightRange(index: 0 | 1, event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  const next = clone(aiBoxConfig.value)
  next.heightRange[index] = value
  aiBoxConfig.value = createAIBoxConfig(next)
}

function resetAIConfig() {
  aiBoxConfig.value = createAIBoxConfig(DEFAULT_AI_BOX_CONFIG)
}

function handleGlobalPointerDown(event: PointerEvent) {
  const target = event.target as HTMLElement
  if (!target.closest('.object-context-menu')) closeContextMenu()
}

function deleteSelected() {
  if (!selectedBox.value) return
  beginEdit()
  boxes.value = boxes.value.filter((box) => String(box.obj_id) !== selectedBoxId.value)
  selectedBoxId.value = null
  dirty.value = true
}

async function copyFromAdjacent(direction: -1 | 1) {
  const selectedId = selectedBoxId.value
  const activeFrameId = currentFrame.value?.frame_id
  const activeSequenceId = sequenceId.value
  if (!selectedId || !activeFrameId) return
  const sourceIndex = frameIndex.value + direction
  if (sourceIndex < 0 || sourceIndex >= frames.value.length) return
  try {
    const response = await api.labels(activeSequenceId, frames.value[sourceIndex].frame_id)
    if (sequenceId.value !== activeSequenceId || currentFrame.value?.frame_id !== activeFrameId) return
    const source = response.boxes.find((box) => String(box.obj_id) === selectedId)
    if (!source) {
      setNotice('相邻帧没有相同 ID 的对象')
      return
    }
    beginEdit()
    const target = boxes.value.find((box) => String(box.obj_id) === String(source.obj_id))
    if (target) Object.assign(target, clone(source))
    else boxes.value.push(clone(source))
    dirty.value = true
    setNotice('已复制相邻帧对象')
  } catch (error) {
    setError(error)
  }
}

async function copyAllToAdjacent(direction: -1 | 1) {
  const targetIndex = frameIndex.value + direction
  if (!boxes.value.length) {
    setNotice('当前帧没有可复制的标注框')
    return
  }
  if (targetIndex < 0 || targetIndex >= frames.value.length || isCopyingAdjacent.value) return
  const targetFrame = frames.value[targetIndex]
  const activeSequenceId = sequenceId.value
  try {
    isCopyingAdjacent.value = true
    const response = await api.labels(activeSequenceId, targetFrame.frame_id)
    const sourceBoxes = clone(boxes.value)
    const sourceIds = new Set(sourceBoxes.map((box) => String(box.obj_id)))
    const retainedTargetBoxes = response.boxes.filter((box) => !sourceIds.has(String(box.obj_id)))
    const replacedCount = response.boxes.length - retainedTargetBoxes.length
    const result = await api.saveLabels(activeSequenceId, targetFrame.frame_id, [
      ...retainedTargetBoxes.map((box) => clone(box)),
      ...sourceBoxes,
    ])
    setNotice(
      `已将当前帧 ${sourceBoxes.length} 个框复制到${direction < 0 ? '上一帧' : '下一帧'}`
      + `${replacedCount ? `，更新 ${replacedCount} 个同 ID 框` : ''}`
      + `${result.warnings.length ? `；${result.warnings.length} 条校验提示` : ''}`,
    )
  } catch (error) {
    setError(error)
  } finally {
    isCopyingAdjacent.value = false
  }
}

function handleKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void save()
  } else if (event.key === 'Delete') {
    deleteSelected()
  } else if (event.key === 'Escape') {
    if (pendingNewClass.value || showNewBoxTypes.value) cancelNewBoxCreation()
    else if (contextMenu.value.visible) closeContextMenu()
    else selectedBoxId.value = null
  } else if (event.key === 'ArrowLeft' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement)) {
    void loadFrame(frameIndex.value - 1)
  } else if (event.key === 'ArrowRight' && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement)) {
    void loadFrame(frameIndex.value + 1)
  }
}

function onSequenceChange(event: Event) {
  void loadSequence((event.target as HTMLSelectElement).value)
}

function onFrameChange(event: Event) {
  void loadFrame(Number((event.target as HTMLSelectElement).value))
}

function onTimelineChange(event: Event) {
  void loadFrame(Number((event.target as HTMLInputElement).value))
}

function renderLoop() {
  scene?.render()
  animationFrame = window.requestAnimationFrame(renderLoop)
}

watch([boxes, selectedBoxId], () => {
  scene?.setBoxes(boxes.value, selectedBoxId.value)
}, { deep: true })

watch([pointSize, colorMode], () => {
  scene?.setPointStyle(pointSize.value, colorMode.value)
})

watch(points, (value) => {
  if (value) scene?.setPoints(value)
})

watch(classes, (value) => {
  scene?.setClasses(value)
})

onMounted(async () => {
  await nextTick()
  if (mainCanvas.value && mainOverlay.value && editorCanvas.value && editorOverlay.value) {
    scene = new SceneManager(
      mainCanvas.value,
      mainOverlay.value,
      editorCanvas.value,
      editorOverlay.value,
      selectBox,
      transformBox,
      endDragEdit,
      (selection) => { void handleCreateRegion(selection) },
      openBoxContextMenu,
    )
    scene.setClasses(classes.value)
    worker = new PointWorkerClient()
    cache = new PointFrameCache(worker)
    aiFitter = new AIBoxFitter(() => aiBoxConfig.value)
    renderLoop()
  }
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('pointerdown', handleGlobalPointerDown)
  await loadSequences()
})

onUnmounted(() => {
  stopPlayback()
  window.cancelAnimationFrame(animationFrame)
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('pointerdown', handleGlobalPointerDown)
  worker?.dispose()
  aiFitter?.resetAIBox()
  scene?.dispose()
})
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">PC</div>
        <div>
          <div class="brand-title">PointCloud Labels Studio</div>
          <div class="brand-subtitle">连续帧点云标注</div>
        </div>
      </div>
      <div class="top-controls">
        <label>序列
          <select :value="sequenceId" @change="onSequenceChange">
            <option v-for="item in sequences" :key="item.sequence_id" :value="item.sequence_id">{{ item.sequence_id }}</option>
          </select>
        </label>
        <label>帧
          <select :value="frameIndex" @change="onFrameChange">
            <option v-for="(item, index) in frames" :key="item.frame_id" :value="index">{{ index }} · {{ item.frame_id }}</option>
          </select>
        </label>
        <button class="button primary" :disabled="!currentFrame || isLoading" @click="save">保存</button>
        <button class="button" :disabled="isLoading" @click="reloadCurrent">重新加载</button>
      </div>
    </header>

    <main class="workspace">
      <aside class="editor-sidebar panel">
        <div v-show="selectedBox" class="edit-view-panel">
          <div class="edit-view-heading">
            <div>
              <div class="form-title">3D Box 三视图</div>
              <div class="edit-view-help">中心柄移动 · 边/角柄自由缩放 · 方向柄旋转</div>
            </div>
          </div>
          <div class="edit-view-shell">
            <canvas ref="editorCanvas" class="editor-canvas"></canvas>
            <div ref="editorOverlay" class="editor-overlay"></div>
            <div class="viewport-caption editor-bev-caption">BEV · XY</div>
            <div class="viewport-caption editor-front-caption">FRONT · XZ</div>
            <div class="viewport-caption editor-side-caption">SIDE · YZ</div>
          </div>
        </div>
        <div v-if="!selectedBox" class="selection-hint">从中间主视图或右侧对象列表选择一个 3D Box 后，这里显示局部三视图。</div>
      </aside>

      <section class="viewer-panel panel">
        <div class="panel-toolbar">
          <div class="toolbar-group">
            <button class="icon-button" title="上一帧" @click="loadFrame(frameIndex - 1)">‹</button>
            <button class="button play-button" @click="togglePlayback">{{ isPlaying ? '暂停' : '播放' }}</button>
            <button class="icon-button" title="下一帧" @click="loadFrame(frameIndex + 1)">›</button>
            <select v-model.number="speed" class="small-select" title="播放倍速">
              <option :value="0.5">0.5×</option><option :value="1">1×</option><option :value="2">2×</option><option :value="4">4×</option>
            </select>
          </div>
          <div class="toolbar-group">
            <label class="geometry-fit-toggle" :title="aiBoxConfig.enabled ? '几何拟合按需运行；同一序列复用地面模型' : '关闭时播放不执行地面提取或几何拟合'">
              <input
                type="checkbox"
                :checked="aiBoxConfig.enabled"
                @change="setAIConfigBoolean('enabled', $event)"
              >
              <span>几何拟合</span>
            </label>
            <button class="button" @click="showAISettings = true">拟合参数</button>
            <label>点颜色
              <select v-model="colorMode" class="small-select">
                <option value="intensity">强度</option><option value="height">高度</option><option value="uniform">统一</option>
              </select>
            </label>
            <label>点大小
              <input v-model.number="pointSize" class="range-input" type="range" min="0.5" max="6" step="0.1">
            </label>
          </div>
        </div>
        <div class="main-viewport-shell">
          <canvas ref="mainCanvas" class="viewport-canvas"></canvas>
          <div ref="mainOverlay" class="main-box-labels"></div>
          <div class="viewport-caption main-caption">MAIN · BEV / XY 鸟瞰</div>
          <div class="main-view-help">
            {{ pendingNewClass ? `新增 ${pendingNewClass.label}：BEV 左键拖出目标区域 · Esc 取消` : '拖拽旋转 · 滚轮缩放 · 中键平移 · 点击类别/ID 标签选择框' }}
          </div>
          <div v-if="pendingNewClass" class="ai-draw-hint">BEV 框选 {{ pendingNewClass.label }} 目标区域</div>
          <div v-if="isAIFitting" class="ai-fitting-overlay"><span class="ai-spinner"></span>几何拟合中…</div>
          <div v-if="isLoading && !isPlaying" class="loading-overlay">加载中…</div>
        </div>
      </section>

      <aside class="inspector panel">
        <div class="panel-heading">
          <div><span class="eyebrow">当前帧</span><h2>{{ currentFrame?.frame_id ?? '—' }}</h2></div>
          <span class="status-dot" :class="{ dirty }" :title="dirty ? '有未保存修改' : '已保存'"></span>
        </div>
        <div class="object-actions-shell">
          <div class="object-actions">
            <button class="button primary" :disabled="isAIFitting || !classes.length" @click.stop="toggleNewBoxTypes">＋ 新增标注框</button>
            <button class="button" :disabled="!selectedBox" @click="deleteSelected">删除标注框</button>
            <button class="icon-button" title="撤销" :disabled="!undoStack.length" @click="undo">↶</button>
            <button class="icon-button" title="重做" :disabled="!redoStack.length" @click="redo">↷</button>
          </div>
          <div v-if="showNewBoxTypes" class="add-box-type-menu" @pointerdown.stop>
            <div class="floating-menu-title">选择标注对象类别</div>
            <button v-for="item in classes" :key="item.id" class="floating-menu-item" @click="armNewBoxCreation(item)">
              <span class="color-dot" :style="{ background: item.color }"></span>
              <span>{{ item.label }}</span>
              <small>{{ item.default_size.join(' × ') }} m</small>
            </button>
          </div>
        </div>

        <div class="object-list">
          <div class="list-header"><span>对象 {{ boxes.length }}</span><span>类别 · ID</span></div>
          <button v-for="box in boxes" :key="`${box.obj_id}-${box.obj_type}`" class="object-row" :class="{ selected: String(box.obj_id) === selectedBoxId }" @click="selectBox(String(box.obj_id))" @contextmenu="openListContextMenu(String(box.obj_id), $event)">
            <span class="color-dot" :style="{ background: classes.find(item => item.id === box.obj_type)?.color ?? '#94A3B8' }"></span>
            <span class="object-type">{{ classes.find(item => item.id === box.obj_type)?.label ?? box.obj_type }}</span>
            <span class="object-id">#{{ box.obj_id }}</span>
          </button>
          <div v-if="!boxes.length" class="empty-list">当前帧没有标签框</div>
        </div>

        <div class="frame-copy-panel">
          <div class="frame-copy-heading">
            <span>整帧复制</span>
            <small>按 Track ID 合并，不删除目标帧独有框</small>
          </div>
          <div class="adjacent-actions">
            <button class="button" :disabled="!boxes.length || frameIndex <= 0 || isCopyingAdjacent || isLoading" @click="copyAllToAdjacent(-1)">复制到上一帧</button>
            <button class="button" :disabled="!boxes.length || frameIndex >= frames.length - 1 || isCopyingAdjacent || isLoading" @click="copyAllToAdjacent(1)">复制到下一帧</button>
          </div>
        </div>

        <div v-if="selectedBox" class="editor-form">
          <div class="form-title">标注框参数</div>
          <label>对象类别
            <select :value="selectedBox.obj_type" @focus="beginInputEdit" @blur="endInputEdit" @change="setCategory">
              <option v-for="item in classOptions" :key="item.id" :value="item.id">{{ item.label }}</option>
            </select>
          </label>
          <label>跟踪标识（Track ID）
            <input :value="selectedBox.obj_id" @focus="beginInputEdit" @blur="endInputEdit" @change="setId">
          </label>
          <div v-for="section in numericSections" :key="section" class="vector-editor">
            <div class="vector-title">{{ section === 'position' ? '中心坐标（m）' : section === 'scale' ? '包围框尺寸（m）' : '欧拉旋转角（rad）' }}</div>
            <div class="vector-fields">
              <label v-for="axis in axes" :key="axis" class="axis-field">
                <span>{{ axis }}</span>
                <input :value="valueOf(section, axis)" type="number" step="0.01" @focus="beginInputEdit" @blur="endInputEdit" @change="setNumeric(section, axis, $event)">
              </label>
            </div>
          </div>
          <div class="adjacent-actions">
            <button class="button" :disabled="frameIndex <= 0" @click="copyFromAdjacent(-1)">从上一帧同步此框</button>
            <button class="button" :disabled="frameIndex >= frames.length - 1" @click="copyFromAdjacent(1)">从下一帧同步此框</button>
          </div>
        </div>
        <div v-else class="selection-hint">选择对象后可在这里编辑类别、ID、位置、尺寸和旋转。</div>
      </aside>
    </main>

    <div
      v-if="contextMenu.visible"
      class="object-context-menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @pointerdown.stop
      @contextmenu.prevent
    >
      <div class="floating-menu-title">标注对象 #{{ contextMenu.boxId }}</div>
      <button class="floating-menu-item context-type-trigger" @click="contextMenu.typeOpen = !contextMenu.typeOpen">
        <span>变更对象类别</span><span>›</span>
      </button>
      <div v-if="contextMenu.typeOpen" class="context-type-submenu">
        <button
          v-for="item in classOptions"
          :key="item.id"
          class="floating-menu-item"
          :class="{ active: boxes.find(box => String(box.obj_id) === contextMenu.boxId)?.obj_type === item.id }"
          @click="changeContextType(item.id)"
        >
          <span class="color-dot" :style="{ background: item.color }"></span><span>{{ item.label }}</span>
        </button>
      </div>
      <button v-if="!contextMenu.idEditing" class="floating-menu-item" @click="beginContextIdEdit">编辑跟踪标识（Track ID）…</button>
      <div v-else class="context-id-editor">
        <input
          v-model="contextMenu.draftId"
          aria-label="新的对象 ID"
          inputmode="numeric"
          pattern="[0-9]*"
          autofocus
          @keydown.enter.prevent="commitContextId"
          @keydown.escape.prevent="contextMenu.idEditing = false"
        >
        <button class="button primary" @click="commitContextId">确定</button>
      </div>
      <div class="floating-menu-separator"></div>
      <button class="floating-menu-item" :disabled="isAIFitting" @click="refitContextBox">重新执行几何拟合</button>
      <button class="floating-menu-item danger" @click="deleteSelected(); closeContextMenu()">删除标注框</button>
    </div>

    <div v-if="showAISettings" class="modal-backdrop" @pointerdown.self="showAISettings = false">
      <section class="ai-settings-modal">
        <header class="modal-header">
          <div>
            <h2>几何拟合参数</h2>
            <p>初始值来自 config.yaml；这里的修改仅作用于当前会话。</p>
          </div>
          <button class="icon-button" aria-label="关闭" @click="showAISettings = false">×</button>
        </header>
        <div class="ai-settings-body">
          <div class="ai-toggle-grid">
            <label v-for="item in [
              { path: 'enabled', label: '启用几何拟合' },
              { path: 'enableDenoise', label: '启用 DBSCAN 聚类去噪' },
              { path: 'preferLongEdgeAsX', label: '将长边定义为局部 X 轴' },
              { path: 'useHeadAngle', label: '使用选区拖拽方向判定朝向' },
              { path: 'useWorker', label: '在后台线程执行拟合' },
            ]" :key="item.path" class="toggle-field">
              <input
                type="checkbox"
                :checked="aiBoxConfig[item.path as 'enabled' | 'enableDenoise' | 'preferLongEdgeAsX' | 'useHeadAngle' | 'useWorker']"
                @change="setAIConfigBoolean(item.path as 'enabled' | 'enableDenoise' | 'preferLongEdgeAsX' | 'useHeadAngle' | 'useWorker', $event)"
              >
              <span>{{ item.label }}</span>
            </label>
          </div>
          <div class="settings-section-title">输入点云高度范围</div>
          <div class="ai-settings-grid">
            <label>最低高度 Z（m）
              <input type="number" step="0.1" :value="aiBoxConfig.heightRange[0]" @change="setHeightRange(0, $event)">
            </label>
            <label>最高高度 Z（m）
              <input type="number" step="0.1" :value="aiBoxConfig.heightRange[1]" @change="setHeightRange(1, $event)">
            </label>
          </div>
          <div class="settings-section-title">地面建模、聚类去噪与包围框搜索</div>
          <div class="ai-settings-grid">
            <label v-for="field in aiNumberFields" :key="field.path">
              {{ field.label }}
              <input
                type="number"
                :step="field.step"
                :min="field.min"
                :max="field.max"
                :value="getAIConfigNumber(field.path)"
                @change="setAIConfigNumber(field, $event)"
              >
            </label>
          </div>
        </div>
        <footer class="modal-footer">
          <button class="button" @click="resetAIConfig">恢复默认拟合参数</button>
          <button class="button primary" @click="showAISettings = false">完成</button>
        </footer>
      </section>
    </div>

    <footer class="timeline panel">
      <div class="timeline-meta"><span>FRAME {{ String(frameIndex + 1).padStart(4, '0') }} / {{ String(frames.length).padStart(4, '0') }}</span><span>{{ currentSequence?.frame_rate ?? 10 }} FPS · {{ labelExists ? '有标签文件' : '无标签文件' }}</span></div>
      <input class="timeline-slider" type="range" min="0" :max="Math.max(0, frames.length - 1)" :value="frameIndex" @change="onTimelineChange">
      <div class="timeline-labels"><span>{{ frames[0]?.frame_id ?? '—' }}</span><span>{{ frames[Math.floor(frames.length / 2)]?.frame_id ?? '—' }}</span><span>{{ frames[frames.length - 1]?.frame_id ?? '—' }}</span></div>
    </footer>

    <div v-if="notice" class="toast notice">{{ notice }}</div>
    <div v-if="errorMessage" class="toast error" @click="errorMessage = ''">{{ errorMessage }}</div>
    <div v-if="warnings.length" class="warning-bar">⚠ {{ warnings.join(' · ') }}</div>
  </div>
</template>
