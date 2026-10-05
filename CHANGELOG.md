# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

## [0.1.0] - 2026-10-05

首次发布。

### 新增

- **探测与自动裁切**（`aivideo_probe` / `shotkit probe`）
  - 从 `ffmpeg -i` 的 banner 解析容器与流信息，**不依赖 ffprobe**
  - 逐行时序统计检测「暗 + 逐帧静止」的条带，识别播放器 UI 覆盖层与黑边
  - OBS / 录屏来源识别（`obs_nvenc_h264_tex` 等编码器标签）
  - 给出建议裁切区域，可 `--crop-bottom` / `--no-crop` 覆盖
- **抗闪烁分镜**（`aivideo_detect_shots` / `shotkit shots`）
  - 取全片逐帧 scene 分数序列，用「孤立尖峰」判据 + 最短镜头时长聚类挑切点
  - 避免 `select='gt(scene,TH)'` 在高动态素材上把闪烁切成大量假镜头
- **逐镜头评估**（`aivideo_analyze` / `shotkit analyze`）
  - 运动量按**模型帧（1/16 秒）**归一化，使不同源帧率可比
  - 运动覆盖率、运动分布（整幅/部分/局部）、闪烁率、清晰度、曝光、暖色占比
  - 「可替换性」加权评分与四档判定
  - 可选生成分镜缩略图拼版（`--filmstrip`）
- **按运动量分组的工作流**（静止 / 轻微 / 中等 / 剧烈四档）
  - 每档给出推荐工具、参数区间与提示词模板
  - 所有外部数字（各工具的单次时长/帧数窗口）集中在 `lib/core/tools-catalog.mjs`，逐条带出处 URL
- **超长镜头子分段**
  - 三档窗口预设：`cloud`（15s）/ `opensource`（5s）/ `tight`（2s）
  - 等分 + 固定重叠，输出 `shot_005_seg02_….mp4`
  - 计算建议拼接点（重叠中点）
- **工作流包导出**（`aivideo_split` / `shotkit cut`）
  - `workflow.json` / `prompts.csv` / `README.md` / `analysis.json` / `clips.json`
  - 工作流 README 含逐镜头清单、子分段表、拼回整片的 ffmpeg 命令
  - 切割模式：`reencode`（帧精确，可应用裁切）/ `copy`（无损，切点吸附关键帧）
- **DSH 插件形态**
  - 4 个原生工具、1 个技能、1 个只读状态路由 `GET /aivideo-shotkit/state`
  - 浏览器端只读状态面板：「设置 → AI 视频切片」
  - 可选能力全部用动态加载：宿主缺服务或缺包时静默跳过，不影响技能与 CLI
- **独立 CLI**（`bin/shotkit.mjs`）
  - `probe` / `shots` / `analyze` / `cut` / `run` 五个子命令
  - 不需要 DSH，不需要 `npm install`
- **自检脚本**
  - `scripts/host-load-test.mjs`：假 Cordis ctx 加载真实 `lib/index.js`，跑真实 `defineTool()`，51 项断言
  - `scripts/make-demo-video.mjs`：生成**完全合成**的演示素材（含假播放器控件条），用于演示与 CI
  - `scripts/smoke-probe.mjs`、`dump-rowstats.mjs`、`dump-scenes.mjs`、`motion-diag.mjs`

### 设计取舍

- **零运行时依赖**：核心只用 Node 内置模块，不引入 opencv / onnxruntime / numpy。
- **不做人脸检测**：因此不需要下载模型、不引入许可风险；代价是镜头尺度需要人工看缩略图确认。
- **不输出镜头尺度推断**：早期版本曾用运动覆盖率反推近景/全身，在真实素材上验证失败（近景算成 9%、远景算成 23%），已移除并改为中性的运动分布标签。
- **`run()` 永远 resolve、不 reject**：沙箱环境下 `spawn` 可能同步抛 EPERM，调用方需要拿到 `spawnError` 才能给出可操作的提示。

### 已知限制

- 条带检测在 160×90 网格上进行，精度约 ±1 个网格行（≈ 帧高的 1/90）。
- 运动量基于亮度差，淡入淡出与打光突变会被读成运动。
- 溶解/擦除等非硬切转场可能导致镜头边界偏移若干帧。
- `--mode copy` 不帧精确。

[Unreleased]: https://github.com/loubaji083-rgb/dsh-plugin-aivideo-shotkit/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/loubaji083-rgb/dsh-plugin-aivideo-shotkit/releases/tag/v0.1.0
