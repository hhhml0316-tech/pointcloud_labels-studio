# 项目记忆：PointCloud Labels Studio

## 当前开发目标

- 本项目（`pc-label_visualization`）是唯一的开发、调试和启动目标。
- 项目名称为 **PointCloud Labels Studio**，架构为 Vue 3 + Vite 前端和 FastAPI 后端。
- 开发模式使用 `show` Conda 环境：后端运行 `python -m backend --config config.yaml`（端口 8000），前端运行 `npm run dev -- --host 127.0.0.1`（端口 5173）。

## 与 SUSTechPOINTS 的边界

- `D:\Research_Workspace\02_R&D_Projects\01_Vision_Perception\SUSTechPOINTS-dev-auto-annotate` 是独立的参考项目和数据来源，**不是**本项目的运行入口。
- 可以参考其标签 JSON 结构、数据目录和配置路径；不得在该目录中启动服务、安装依赖或修改代码，除非用户明确要求。
- `config.yaml` 中指向 SUSTechPOINTS 目录的路径仅用于读取本地 LiDAR / label 数据，不表示要运行 SUSTechPOINTS。

## 启动前检查

- 默认从本项目根目录执行命令，浏览器访问开发前端 `http://127.0.0.1:5173`。
- 不要把 SUSTechPOINTS 的 CherryPy 服务（8081）与本项目的 FastAPI/Vite 服务（8000/5173）混淆。
