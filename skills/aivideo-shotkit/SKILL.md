---
name: aivideo-shotkit
description: AI 生成视频的分镜切割与人物替换工作流：识别播放器 UI 覆盖层、按场景切分镜、逐镜头评估并导出可投喂换脸/动作迁移工具的片段与工作流包。
---

# AI 视频分镜切割与人物替换（aivideo-shotkit）

把一段视频切成**多个可以单独做人物替换的片段**，并为每个片段给出「该用哪个模型、填什么参数、写什么提示词」。

## 什么时候用它

- 用户给了一段视频，想按镜头切开、批量处理；
- 用户想做人物替换（换脸、动作迁移、数字人驱动）但不想自己找切点；
- 素材是**录屏**（OBS / 剪映录屏 / 屏幕录制），画面里带播放器进度条、控件；
- 用户说「工作流划分」「分镜」「切片」「按镜头拆」「能不能换掉里面的人」。

## 四个工具

| 工具 | 作用 | 写文件 |
| --- | --- | --- |
| `aivideo_probe` | 探测编码/分辨率/时长/音轨，**检测播放器 UI 覆盖层与黑边**，给出建议裁切 | 否 |
| `aivideo_detect_shots` | 只做分镜切分，返回镜头表与切点分数 | 否 |
| `aivideo_analyze` | 分镜 + 逐镜头指标 + 可替换性评分 + 工作流分组 | 可选缩略图 |
| `aivideo_split` | **切割导出片段**（默认按模型窗口二次切分）+ 生成工作流包（workflow.json / prompts.csv / README.md） | 是 |

## 标准动作顺序

1. **先探测**：`aivideo_probe`。如果素材是录屏，它会报出底部有多少像素是播放器控件条——这些必须裁掉，否则替换模型会把进度条当成画面内容。
2. **再分析**：`aivideo_analyze`，带上 `outputDir` 以生成 `filmstrip.jpg`（20 个镜头一张拼图）。
3. **目视确认**：用 `read_image` 打开 `filmstrip.jpg`。**这一步不能省**——见下方「唯一不能相信的指标」。
4. **最后切割**：`aivideo_split`（默认已带子分段），默认 `mode=reencode`（帧精确、可同时应用裁切）；只想要无损快速切片时用 `mode=copy` 并加 `segment=false`。

## 唯一不能相信的指标

插件**没有内置人脸检测器**（本机没有 cv2 / onnxruntime / torch，插件也不带模型权重）。报告里的：

- `暖色占比`（`skinRatio`）、`warmCoverage`、`warmBox`

是 YCbCr + RGB 的**肤色规则**结果，不是人物检测。在暖光/红色环境里，墙面、床垫、台灯都会被算成「肤色」。实测在一个红色卧室素材上，它一度把 20 个镜头里的 13 个判成「无人」。

因此：

- 这些数字**只能用于镜头之间的相对排序**，不能用来下「这个镜头没有人」的结论；
- **镜头尺度（近景 / 半身 / 全身 / 远景）必须靠 `filmstrip.jpg` 目视判断**；`运动覆盖` 只说运动分布，不说尺度；
- 评分与分组依据的是**运动量**（真实测量），不是人物构图；
- 向用户汇报时，不要说「检测到人物」，要说「暖色像素占比偏高（启发式）」。

## 分组口径（按运动量）

运动量的单位统一成**「一个模型帧（1/16 秒）内的平均亮度差」**，这样 24fps / 30fps / 60fps 的素材可以直接比。

| 分组 | 运动量 | 含义 | 首选工具 |
| --- | --- | --- | --- |
| 静止镜头 | < 1 | 画面几乎不动 | Kling 首尾帧 / Runway 图生视频、LivePortrait |
| 轻微运动 | 1 – 4 | 小幅表演 | **Wan Animate**、LivePortrait、LatentSync |
| 中等运动 | 4 – 12 | 明确大动作 / 镜头移动 | Wan Animate、VACE |
| 剧烈运动 | ≥ 12 | 快速摇镜、拖影、闪烁 | VACE；**先切短再送** |

`运动覆盖`（`motionCoverage`）是第二个维度：**画面中有明显运动的区域占比**。越小说明只有主体在动、背景干净（好替换），越大说明整幅都在动（摇镜，背景被拖着走，难替换）。

**不要用它推镜头尺度。** 试过，拿 filmstrip 一对就崩了：近景快动作和远景快动作都会落在中段（实测一个近景镜头算出 9%，一个远景镜头算出 23%）。

## 子分段：每个模型都有单次时长上限

这是「必须切」的根本原因——把整段 60 秒塞进任何一个工具都不会成功：

| 工具 | 单次上限 |
| --- | --- |
| Wan Animate（API） | 2–30s |
| Wan Animate（ComfyUI 节点） | 81 帧 @16fps ≈ **5.06s** |
| VACE / Wan2.1 | 81 帧 @16fps |
| Kling 3.0 系 / O1 / 2.6 / 2.5 Turbo | 3–15s / 3–10s / 5 或 10s |
| Viggle（驱动视频） | 5–15s |
| Runway Act-Two | 3–30s |

因此 `aivideo_split` **默认开启子分段**：超过当前窗口的镜头会被二次切分成 `<镜头>_seg<NN>_….mp4`，相邻段之间保留重叠（供模型续接、也给拼接留余量），每个片段的建议拼接点写进 `workflow.json` 与 README。

窗口预设（`--segment-preset`）：

| 预设 | 窗口 | 最小段 | 重叠 | 适用 |
| --- | --- | --- | --- | --- |
| `cloud`（默认） | 15s | 3s | 1s | Kling / Viggle / Runway / Wan Animate API |
| `opensource` | 5s | 2s | 1s | ComfyUI Wan Animate、VACE（81 帧 @16fps） |
| `tight` | 2s | 1s | 0.5s | 身份漂移严重时的保守设置 |

**重叠是实际算出来的，不是硬塞的**：段数按 `ceil((时长-重叠)/(窗口-重叠))` 取，再把总时长**均分**给各段（首段锚 0、末段锚结尾），所以实际重叠可能略大于请求值——`segments[].overlapWithPrev` 里给的是真实值。均分而不是「塞满 + 尾巴」，是为了每段动作量一致、不产生一个很短的弱段。

## 许可红线（做人物替换前必须知道）

- **可以用**：VACE / Wan2.1（Apache-2.0）、LivePortrait（MIT）、Champ（MIT）、YuNet 人脸检测（MIT）。
- **不能商用**：`insightface` / `buffalo_l` / `inswapper_128.onnx` / `inswapper_128_fp16.onnx` / `codeformer-v0.1.0.pth` —— 全部标注 **non-commercial research only**，2025-11-24 起官方要求联系 `recognition-oss-pack@insightface.ai` 授权。很多「AI 换脸一键包」默认就是这套权重。
- 换脸场景下，**本人素材**与**他人肖像**的差别是法律问题，不是技术问题；涉及真人时提醒用户先拿到授权。
- 首选人脸检测器是 **YuNet**（OpenCV Zoo，整目录 MIT，可检 10×10 到 300×300 像素），但本插件不带模型，检测要另外装 `onnxruntime`。

## 汇报给用户的建议格式

1. 一句话说清素材与切分结果（几个镜头、总时长、有没有裁掉播放器 UI）；
2. 分组表：每组几个镜头、用哪个模型、什么参数；
3. 逐镜头表：`#编号 / 时间码 / 时长 / 运动量 / 判定`；
4. 输出目录与生成的文件清单；
5. **如实说一句**：主体指标是启发式，镜头尺度请对照 filmstrip 确认。

## 命令行（不依赖 DSH 宿主）

```powershell
node <插件目录>\bin\shotkit.mjs probe   "<视频>"
node <插件目录>\bin\shotkit.mjs shots   "<视频>"
node <插件目录>\bin\shotkit.mjs analyze "<视频>" --filmstrip --out "<目录>"
node <插件目录>\bin\shotkit.mjs cut     "<视频>" --out "<目录>" --mode reencode
node <插件目录>\bin\shotkit.mjs run     "<视频>" --out "<目录>" --filmstrip
```

常见参数：

- 分镜：`--min-shot 1.5`（最短镜头）、`--min-score 0.3`（场景阈值）；
- 裁切：`--crop-bottom 80`（手动裁底部）、`--crop <w>x<h>+<x>+<y>`、`--no-crop`、`--auto-sides`（连左右也自动裁，默认关）；
- 挑选：`--only 1,3,5`、`--min-verdict good`、`--quality balanced`、`--mode copy|reencode`；
- 子分段：`--no-segment`（关掉，一个镜头一个文件）、`--segment-preset cloud|opensource|tight`、`--max-segment 5`、`--min-segment 2`、`--overlap 1`；
- `run` 与 `analyze` 都支持 `--filmstrip`。

`--mode copy` 是**切点吸附关键帧**的无损切法，不帧精确；选了 `--mode copy` 又开了子分段时，插件会自动降级成重编码并给出警告——子分段要帧精确切点。

## 排查

- **ffmpeg 找不到**：插件按「配置 → `AIVIDEO_FFMPEG` / `FFMPEG_PATH` → PATH → 常见安装位置」探测；本机可用的是 `%LOCALAPPDATA%\oopz\ffmpeg.exe`。用 `aivideo_probe` 的返回确认实际用的哪一份。
- **不需要 ffprobe**：全部元数据、关键帧时间、逐帧场景分都从 `ffmpeg` 自己解析。
- **切点太碎**：调大 `minShotSeconds`（如 2.0）或 `minScore`（如 0.35）。
- **切点太少**：调小 `minScore`（如 0.2）。
- **分析的镜头数不合理**：先用 `aivideo_detect_shots` 单独看镜头表，再决定参数。
