# PointCloud Labels Studio

浏览器端连续帧点云可视化与 3D 标注工具。项目适合在本地打开多帧 LiDAR 点云，检查和编辑 3D Bounding Box，并将结果保存为兼容 SUSTechPOINTS 结构的 JSON 标签文件。

项目由两个部分组成：

- `src/`：Vue 3 + TypeScript + Three.js 前端，负责点云渲染和交互式 Box 编辑。
- `backend/`：FastAPI 后端，负责读取点云、索引帧、加载/校验/保存标签。

## 功能

- 3D 主视图，以及 BEV、前视图、侧视图编辑视图
- XYZI 点云的强度、高度和统一颜色显示
- 新增、选择、移动、缩放、旋转和删除 3D Box
- 编辑类别、Track ID、位置、尺寸和 roll / pitch / yaw
- 上一帧、下一帧、连续播放、相邻帧复制、撤销和重做
- Worker 解析点云、相邻帧预取和前端帧缓存
- 标签保存采用临时文件替换；已有标签会自动生成 `.bak` 备份
- 未配置标签目录时，首次保存会在点云目录旁自动创建 `label/`

## 支持的数据格式

### 点云

当前支持 `.bin` 文件，每条记录为小端序 `float32[4]`：

```text
x, y, z, intensity
```

同一序列中的帧按文件名自然排序，例如 `000001.bin`、`000002.bin`。点云目录中可以只放 `.bin` 文件，其他文件会被忽略。

### 标签

标签文件与点云使用相同的文件名 stem，例如 `000001.bin` 对应 `000001.json`。JSON 根节点是数组，每个 Box 至少包含：

```json
[
  {
    "obj_type": "Car",
    "obj_id": "1",
    "psr": {
      "position": {"x": 1.0, "y": 2.0, "z": 0.8},
      "scale": {"x": 4.5, "y": 2.0, "z": 1.6},
      "rotation": {"x": 0.0, "y": 0.0, "z": 0.2}
    }
  }
]
```

历史类别字符串和未识别字段会尽量原样保留；`classes` 配置只决定类别显示名称、颜色和新增 Box 的默认尺寸。

## 环境要求

- Python 3.10 或更高版本
- Node.js 18 或更高版本
- 支持 WebGL 的现代浏览器（Chrome、Edge、Firefox 等）
- 不要求 CUDA，CPU 即可运行

## 快速开始

### 1. 获取代码并安装依赖

```powershell
git clone git@github.com:hhhml0316-tech/pointcloud_labels-studio.git
Set-Location pointcloud_labels-studio

conda env create -f environment.yml
conda activate pointcloud-labels-studio
npm ci
```

如果不使用 Conda，也可以使用 Python 虚拟环境：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
npm ci
```

### 2. 配置数据目录

复制示例配置：

```powershell
Copy-Item config.example.yaml config.yaml
```

编辑 `config.yaml` 中的 `sequences`。相对路径以 `config.yaml` 所在目录为基准；也可以填写绝对路径。推荐的数据结构如下：

```text
data/
└── demo/
    ├── lidar/
    │   ├── 000001.bin
    │   └── 000002.bin
    └── label/
        ├── 000001.json
        └── 000002.json
```

最小配置示例：

```yaml
sequences:
  - id: demo
    lidar_dir: ./data/demo/lidar
    label_dir: ./data/demo/label
    point_format: xyz_i_float32_le
    frame_rate: 10

classes:
  - id: Car
    label: Car
    color: '#3B82F6'
    default_size: [4.5, 2.0, 1.6]

server:
  host: 127.0.0.1
  port: 8000
```

`config.yaml` 只用于本机数据路径，已加入 Git 忽略规则；请提交 `config.example.yaml`，不要提交真实点云和标签数据。

### 3. 启动

#### 开发模式

终端 A 启动后端：

```powershell
conda activate pointcloud-labels-studio
python -m backend --config config.yaml
```

终端 B 启动 Vite：

```powershell
npm run dev -- --host 127.0.0.1
```

浏览器访问 <http://127.0.0.1:5173>。Vite 会将 `/api` 请求代理到后端的 `8000` 端口。

#### 本地构建模式

```powershell
npm run build
python -m backend --config config.yaml
```

浏览器访问 <http://127.0.0.1:8000>。构建后的 `dist/` 由 FastAPI 直接托管。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动 Vite 开发服务器 |
| `npm run build` | TypeScript 类型检查并构建前端 |
| `npm run preview` | 预览前端构建结果 |
| `python -m backend --config config.yaml` | 启动 FastAPI 后端 |
| `python -m pytest tests -q` | 运行后端测试 |

## 目录说明

```text
backend/             FastAPI 应用、数据索引、点云和标签处理
src/                 Vue 前端、Three.js 渲染和交互逻辑
tests/               后端单元测试
config.example.yaml  可提交的配置模板
config.yaml          本机配置，不提交
environment.yml      Conda 环境定义
```

## 注意事项

- 点云通常体积较大，数据目录默认不会提交到 Git。
- 后端会校验标签中的 Box 结构、数值和类别，并将校验提示返回给前端。
- 保存已有标签时会生成同名 `.bak` 文件；`.bak` 文件也不应提交到公开仓库。
- 当前项目没有附带新的许可证文件；如需公开发布或用于商业项目，请先确认代码和数据的授权范围。

## 开发检查

```powershell
npm run build
python -m pytest tests -q
git diff --check
```
