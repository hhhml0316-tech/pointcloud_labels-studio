<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { api, PointWorkerClient } from './api'
import { PointFrameCache } from './pointCache'
import { SceneManager } from './render/SceneManager'
import type { ClassConfig, FrameInfo, LabelBox, PointFrame, SequenceInfo, Vec3 } from './types'

type NumericSection = 'position' | 'scale' | 'rotation'
type Axis = 'x' | 'y' | 'z'

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
const numericSections: NumericSection[] = ['position', 'scale', 'rotation']
const axes: Axis[] = ['x', 'y', 'z']

let scene: SceneManager | null = null
let worker: PointWorkerClient | null = null
let cache: PointFrameCache | null = null
let animationFrame = 0
let playTimer: number | undefined
let inputEditActive = false
let dragEditActive = false

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
    sequences.value = await api.sequences()
    classes.value = await api.classes()
    if (sequences.value.length) await loadSequence(sequences.value[0].sequence_id)
  } catch (error) {
    setError(error)
  }
}

async function loadSequence(nextId: string) {
  if (!nextId) return
  if (dirty.value && !window.confirm('当前帧有未保存修改，切换序列将丢弃修改，继续？')) return
  stopPlayback()
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
    warnings.value = labels.warnings
    labelExists.value = labels.label_exists
    selectedBoxId.value = null
    dirty.value = false
    undoStack.value = []
    redoStack.value = []
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
  void loadFrame(next).then(() => {
    if (isPlaying.value) playTimer = window.setTimeout(playNext, 1000 / Math.max(0.1, (currentSequence.value?.frame_rate ?? 10) * speed.value))
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

function addBox() {
  beginEdit()
  const config = classes.value[0] ?? { id: 'Car', label: 'Car', color: '#3B82F6', default_size: [4.5, 2, 1.6] as [number, number, number] }
  const numericIds = boxes.value.map((box) => Number(box.obj_id)).filter((value) => Number.isInteger(value))
  const nextId = numericIds.length ? String(Math.max(...numericIds) + 1) : `new-${boxes.value.length + 1}`
  const box: LabelBox = {
    obj_id: nextId,
    obj_type: config.id,
    psr: {
      position: { x: 0, y: 0, z: config.default_size[2] / 2 },
      scale: { x: config.default_size[0], y: config.default_size[1], z: config.default_size[2] },
      rotation: { x: 0, y: 0, z: 0 },
    },
  }
  boxes.value.push(box)
  selectedBoxId.value = nextId
  dirty.value = true
}

function deleteSelected() {
  if (!selectedBox.value) return
  beginEdit()
  boxes.value = boxes.value.filter((box) => String(box.obj_id) !== selectedBoxId.value)
  selectedBoxId.value = null
  dirty.value = true
}

async function copyFromAdjacent(direction: -1 | 1) {
  if (!selectedBox.value) return
  const sourceIndex = frameIndex.value + direction
  if (sourceIndex < 0 || sourceIndex >= frames.value.length) return
  try {
    const response = await api.labels(sequenceId.value, frames.value[sourceIndex].frame_id)
    const source = response.boxes.find((box) => String(box.obj_id) === String(selectedBox.value!.obj_id))
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

function handleKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void save()
  } else if (event.key === 'Delete') {
    deleteSelected()
  } else if (event.key === 'Escape') {
    selectedBoxId.value = null
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
    scene = new SceneManager(mainCanvas.value, mainOverlay.value, editorCanvas.value, editorOverlay.value, selectBox, transformBox, endDragEdit)
    scene.setClasses(classes.value)
    worker = new PointWorkerClient()
    cache = new PointFrameCache(worker)
    renderLoop()
  }
  window.addEventListener('keydown', handleKeydown)
  await loadSequences()
})

onUnmounted(() => {
  stopPlayback()
  window.cancelAnimationFrame(animationFrame)
  window.removeEventListener('keydown', handleKeydown)
  worker?.dispose()
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
          <div class="main-view-help">默认 BEV · 拖拽旋转 · 滚轮缩放 · 中键平移</div>
          <div v-if="isLoading && !isPlaying" class="loading-overlay">加载中…</div>
        </div>
      </section>

      <aside class="inspector panel">
        <div class="panel-heading">
          <div><span class="eyebrow">当前帧</span><h2>{{ currentFrame?.frame_id ?? '—' }}</h2></div>
          <span class="status-dot" :class="{ dirty }" :title="dirty ? '有未保存修改' : '已保存'"></span>
        </div>
        <div class="object-actions">
          <button class="button primary" @click="addBox">＋ 新增框</button>
          <button class="button" :disabled="!selectedBox" @click="deleteSelected">删除</button>
          <button class="icon-button" title="撤销" :disabled="!undoStack.length" @click="undo">↶</button>
          <button class="icon-button" title="重做" :disabled="!redoStack.length" @click="redo">↷</button>
        </div>

        <div class="object-list">
          <div class="list-header"><span>对象 {{ boxes.length }}</span><span>类别 · ID</span></div>
          <button v-for="box in boxes" :key="`${box.obj_id}-${box.obj_type}`" class="object-row" :class="{ selected: String(box.obj_id) === selectedBoxId }" @click="selectBox(String(box.obj_id))">
            <span class="color-dot" :style="{ background: classes.find(item => item.id === box.obj_type)?.color ?? '#94A3B8' }"></span>
            <span class="object-type">{{ classes.find(item => item.id === box.obj_type)?.label ?? box.obj_type }}</span>
            <span class="object-id">#{{ box.obj_id }}</span>
          </button>
          <div v-if="!boxes.length" class="empty-list">当前帧没有标签框</div>
        </div>

        <div v-if="selectedBox" class="editor-form">
          <div class="form-title">框属性</div>
          <label>类别
            <select :value="selectedBox.obj_type" @focus="beginInputEdit" @blur="endInputEdit" @change="setCategory">
              <option v-for="item in classOptions" :key="item.id" :value="item.id">{{ item.label }}</option>
            </select>
          </label>
          <label>Track ID
            <input :value="selectedBox.obj_id" @focus="beginInputEdit" @blur="endInputEdit" @change="setId">
          </label>
          <div v-for="section in numericSections" :key="section" class="vector-editor">
            <div class="vector-title">{{ section === 'position' ? '位置' : section === 'scale' ? '尺寸' : '旋转 · 弧度' }}</div>
            <div class="vector-fields">
              <label v-for="axis in axes" :key="axis" class="axis-field">
                <span>{{ axis }}</span>
                <input :value="valueOf(section, axis)" type="number" step="0.01" @focus="beginInputEdit" @blur="endInputEdit" @change="setNumeric(section, axis, $event)">
              </label>
            </div>
          </div>
          <div class="adjacent-actions">
            <button class="button" @click="copyFromAdjacent(-1)">复制上一帧</button>
            <button class="button" @click="copyFromAdjacent(1)">复制下一帧</button>
          </div>
        </div>
        <div v-else class="selection-hint">选择对象后可在这里编辑类别、ID、位置、尺寸和旋转。</div>
      </aside>
    </main>

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
