**English** · [简体中文](./README.md)

# aivideo-shotkit

> **Automatically split one AI-generated video (or screen recording) into clips that can be fed directly to character-replacement tools.**
> Automatically detect and crop the player UI overlay → split into shots by scene → measure motion per shot → split over-long shots into sub-segments → export a workflow bundle with prompts and a stitching plan.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/loubaji083-rgb/dsh-plugin-aivideo-shotkit/actions/workflows/ci.yml/badge.svg)](https://github.com/loubaji083-rgb/dsh-plugin-aivideo-shotkit/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen.svg)](package.json)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-success.svg)](#依赖)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-4f46e5.svg)](https://github.com/deepseek-ai)

---

## Table of Contents

- [What problem it solves](#what-problem-it-solves)
- [What it does not do](#what-it-does-not-do)
- [Features](#features)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Output](#output)
- [Command and tool reference](#command-and-tool-reference)
- [How it works](#how-it-works)
- [The numbers behind the parameters (all sourced)](#the-numbers-behind-the-parameters-all-sourced)
- [Capability limits](#capability-limits)
- [License red lines](#license-red-lines)
- [FAQ](#faq)
- [Development and testing](#development-and-testing)
- [Contributing](#contributing)
- [License](#license)

---

## What problem it solves

Nearly every character-replacement / face-swap / motion-transfer model is a **single-call, single-shot** tool, and its window is narrow:

- ComfyUI's `WanAnimate2ToVideo` takes only **81 frames @16fps ≈ 5.06 seconds** per call by default;
- Kling 3.0 series: **3–15 seconds** per call, Runway Act-Two: **3–30 seconds**, Viggle: **5–15 seconds**;
- Runway's own docs also explicitly require **"No cuts that interrupt the shot"** (no cut inside a single clip).

So a finished video tens of seconds long **cannot be fed in directly** — you first have to split it into shots, then split the over-long shots into sub-segments, and the adjacent sub-segments need to overlap so they can be stitched back together.

This tool is that preprocessing step. It turns "eyeball it and cut with manual ffmpeg" into one repeatable command, and writes the **recommended tool, parameters, prompts, and stitch points for every clip** into a single workflow bundle.

It was originally written to handle **screen-recording footage**: many AI videos are recorded off a player, with a progress bar and danmaku box pressed onto the bottom of the frame, and if you feed that straight into face swap the model models the controls as picture content. So the first step is to automatically detect and crop that overlay.

## What it does not do

Let's get the ugly part out of the way first, so you don't install it and only then find it doesn't match your expectations:

- **It has no face detector.** It does not decide whether there is a person in frame, whether a face is visible, or whether it is a close-up. The runtime needs only Node + ffmpeg, and downloads no models.
- **It does not do character replacement for you.** It only produces "clips you can take to a replacement tool" plus the accompanying notes; the replacement itself is done by Wan Animate / VACE / Kling / LivePortrait and the like.
- **It does not recognize people.** No face recognition, no distinguishing between characters.
- **Its "warm/skin-tone pixel share" is only a picture-statistics heuristic**, and runs high in warm-lit interiors; **it cannot be used as evidence of "is there a person"**, only for relative ordering.

## Features

| Capability | Description |
| --- | --- |
| **Automatic player-UI cropping** | Per-row temporal statistics find strips that are "dark + static frame to frame", recognize OBS/screen-recording sources, and give a crop suggestion. Measured on a 2560×1440 bilibili screen recording, it correctly detected the 80px control strip at the bottom. |
| **Flicker-resistant shot detection** | It does not use `select='gt(scene,TH)'` directly (on high-motion footage that splits flicker into a pile of fake shots); instead it takes the whole-video scene-score series and applies an "isolated spike" criterion plus minimum-shot-duration clustering. |
| **Per-shot motion magnitude** | Normalized to **the average luma difference per model frame (1/16 s)**, so footage with different source frame rates can be compared directly. Comes with motion coverage, flicker, sharpness, brightness and other metrics. |
| **Grouping by motion magnitude** | Four buckets — still / subtle / moderate / intense — each with its own workflow strategy and recommended tools. |
| **Sub-segmentation of over-long shots** | Split evenly by the tool's per-call window preset (15s / 5s / 2s) with an overlap kept, emitting `shot_005_seg02_….mp4`. |
| **Workflow bundle** | One run produces `workflow.json` / `prompts.csv` / `README.md` / `analysis.json` / `clips.json`, with per-clip prompts and the command to stitch back into the full video. |
| **Three ways to use it** | DSH plugin (4 native tools + a skill + a status panel), standalone CLI, or `import` the core module directly. |
| **Zero runtime dependencies** | The core uses only Node built-ins (`spawn` + typed arrays); no numpy / opencv / onnxruntime. |
| **No ffprobe needed** | Metadata is parsed from the `ffmpeg -i` banner, so a single ffmpeg is enough to run. |

## Installation

### Prerequisite: ffmpeg

You need a **callable ffmpeg** (ffprobe is not required). Detection order:

1. `ffmpegPath` in the plugin config / parameters
2. The environment variables `AIVIDEO_FFMPEG`, `FFMPEG_PATH`
3. The system `PATH`
4. Common install locations (Windows: `%LOCALAPPDATA%\oopz\ffmpeg.exe`, `%APPDATA%\bilibili\ffmpeg\ffmpeg.exe`, etc.)

```bash
ffmpeg -version        # just confirm it works
```

> A build **4.x or newer** is recommended. During development the core paths were also verified on ffmpeg 3.0.1 (a 2016 build), but old builds lack filters such as `scdet`, and have no NVENC.

### Option 1: Install into DSH (recommended — gives you tools + skill + panel)

```bash
# install from GitHub (the package name is the directory name)
dsh plugin --profile <your-profile> add github:loubaji083-rgb/dsh-plugin-aivideo-shotkit

# or install from a local clone
git clone https://github.com/loubaji083-rgb/dsh-plugin-aivideo-shotkit.git
dsh plugin --profile <your-profile> add file:/absolute/path/dsh-plugin-aivideo-shotkit
```

You can also install it directly in DSH's graphical plugin manager. **After installing, the profile must be reloaded (restart DSH)**, because a profile's bundle list is assembled at startup.

Once installed you get:

- 4 native tools: `aivideo_probe` / `aivideo_detect_shots` / `aivideo_analyze` / `aivideo_split`
- 1 skill, `aivideo-shotkit` (the model picks it up automatically when you mention video splitting / character replacement)
- 1 read-only status panel: "Settings → AI Video Shotkit", showing a summary of the most recent analysis/cut
- 1 read-only route, `GET /aivideo-shotkit/state`

### Option 2: CLI only (no DSH)

```bash
git clone https://github.com/loubaji083-rgb/dsh-plugin-aivideo-shotkit.git
cd dsh-plugin-aivideo-shotkit
node bin/shotkit.mjs run "<your-video>" --out ./out --filmstrip
```

The CLI needs no dependencies installed and no DSH.

### Option 3: Use it as a library

```js
import { analyzeVideo, exportShots, resolveToolchain } from './lib/core/pipeline.mjs';

const tc = resolveToolchain();
const analysis = await analyzeVideo(tc.ffmpeg, 'input.mp4', { outputDir: './out' });
const result = await exportShots(tc.ffmpeg, 'input.mp4', analysis, { outputDir: './out' });
```

## Quick start

### 0. Run the synthetic demo first (30 seconds, does not touch your footage)

The repo ships a **fully synthetic** demo-footage generator — it builds a video with a "fake player control strip" on the spot, which is exactly what you want to verify the whole pipeline:

```bash
node scripts/make-demo-video.mjs --out demo/demo.mp4
node bin/shotkit.mjs run demo/demo.mp4 --out demo/out --filmstrip
```

Expected result (measured):

```
video 640x388 -> crop {"x":0,"y":0,"width":640,"height":358}  playerUi true  chromeBottomPx 30
scene.max 1   shots 6
  #1 0->3  motion 0.00 static  local  cat still   score 0.61
  #2 3->6  motion 3.91 moderate mixed cat subtle  score 0.86
  #3 6->9  motion 0.00 static  local  cat still   score 0.52
  #4 9->12 motion 2.36 low     mixed cat subtle  score 0.81
  #5 12->15 motion 0.00 static local  cat still   score 0.61
  #6 15->18 motion 3.23 moderate mixed cat subtle score 0.85
```

All 6 scenes land on the exact 3.000 / 6.000 / 9.000 / 12.000 / 15.000 second cut points, and the bottom control strip is cropped automatically.

![Filmstrip of the synthetic demo footage](assets/demo-filmstrip.jpg)

### 1. Process your own footage

**Inside DSH** (the model calls them in order automatically):

```
first, aivideo_probe to check whether the footage has a player UI overlay
then aivideo_analyze to detect shots and evaluate each one
once you are happy, aivideo_split to cut the clips and write the workflow bundle
```

**On the command line** (one command runs the whole flow):

```bash
node bin/shotkit.mjs run "<video-path>" --out ./out --filmstrip
```

`run` = `analyze` + `cut`. See the next section for the artifacts.

### 2. Adjust as needed

```bash
# local open-source pipeline (ComfyUI / VACE): tighten the per-call window to 5s
node bin/shotkit.mjs run "<video>" --segment-preset opensource

# lossless cut (fast, but cut points snap to the nearest keyframe)
node bin/shotkit.mjs run "<video>" --mode copy --no-segment

# process only the first 5 shots, skip the filmstrip
node bin/shotkit.mjs run "<video>" --only 1,2,3,4,5

# footage is already cropped -- do not touch the frame area
node bin/shotkit.mjs run "<video>" --no-crop
```

## Output

Under `--out <dir>` you get:

```
out/
├── shot_001_00h00m00s000-00h00m02s183.mp4      one clip per shot
├── shot_005_seg01_00h00m09s133-00h00m12s133.mp4  sub-segment of an over-long shot (overlapping)
├── shot_005_seg02_00h00m10s716-00h00m13s716.mp4
├── ...
├── filmstrip.jpg                                the filmstrip contact sheet (--filmstrip)
├── .frames/f001.jpg ... f020.jpg                one still per shot
├── workflow.json                                the full machine-readable workflow plan
├── prompts.csv                                  per-sub-segment prompt table (opens in Excel)
├── analysis.json                                raw per-frame statistics and per-shot metrics
├── clips.json                                   the cut manifest
└── README.md                                    the human-readable guide (includes stitch commands)
```

`README.md` is the most useful one of the set; it contains:

- Overview: how many shots were cut, how many feedable clips, average shot length
- Which window each group uses, and which tools are recommended
- Per-shot list: start/end / duration / segment count / group / motion distribution / verdict / replaceability / motion magnitude / motion coverage
- Sub-segment table for long shots: each segment's file, overlap duration, **suggested stitch point**
- The 5-step "stitch back into the full video" procedure and copy-pasteable ffmpeg commands

## Command and tool reference

### CLI

```bash
node bin/shotkit.mjs <command> [options]
```

| Command | Purpose |
| --- | --- |
| `probe <video>` | Probe metadata and picture overlay only, writes no files |
| `shots <video>` | Shot detection only, returns the shot list and cut-point scores |
| `analyze <video>` | Shot detection + per-shot evaluation + grouping |
| `cut <video>` | Cut only (can reuse a previous analysis result) |
| `run <video>` | `analyze` + `cut`, the whole thing in one command |

Common options:

```
--out DIR            output directory
--filmstrip          build the filmstrip contact sheet (analyze command)
--json               print JSON (probe/shots/analyze)
--min-shot SEC       minimum shot length, default 1.5
--min-score N        scene-score threshold, default 0.3
--only LIST          export only these shot numbers, e.g. 1,3,5
--min-verdict V      export only shots scoring at least V: excellent|good|fair
--no-crop            do not crop the player UI overlay
--crop-bottom N      crop this many pixels off the bottom, manually
--segment            split over-long shots into feedable sub-segments (on by default)
--no-segment         disable sub-segmentation: one file per shot
--segment-preset P   cloud (default, <=15s) | opensource (<=5s) | tight (<=2s)
--max-segment N      custom per-segment ceiling in seconds (overrides the preset)
--min-segment N      custom minimum segment length (defaults to the preset)
--overlap N          custom inter-segment overlap in seconds (defaults to the preset)
--mode MODE          reencode (default, frame-accurate) | copy (lossless, snaps to keyframes)
--quality Q          high | balanced (default) | fast | lossless
```

### DSH tools

#### `aivideo_probe`

Probes the video's codec/resolution/frame rate/duration/audio track, and detects a player UI overlay or black bars, giving a suggested crop region. **Call it before doing any cutting on screen-recording footage.**

| Parameter | Type | Description |
| --- | --- | --- |
| `video` | string **required** | Absolute path to the video file |
| `ffmpegPath` | string | Optional; auto-detected if empty |

#### `aivideo_detect_shots`

Shot detection only; returns the shot list and cut-point scores, does no evaluation and writes no files.

| Parameter | Type | Description |
| --- | --- | --- |
| `video` | string **required** | Absolute path to the video file |
| `ffmpegPath` | string | Optional |
| `minShotSeconds` | number | Minimum shot duration, default 1.5 |
| `minScore` | number | Scene score threshold, default 0.3 |
| `cropBottom` | number | Manually specify how many pixels to crop off the bottom |
| `keepFullFrame` | boolean | When true, do not crop at all |

#### `aivideo_analyze`

Shot detection + per-shot evaluation + grouping. Optionally outputs `filmstrip.jpg`.

On top of `aivideo_detect_shots`, it adds:

| Parameter | Type | Description |
| --- | --- | --- |
| `segmentPreset` | string | Sub-segment window preset |
| `maxSegmentSec` | number | Custom per-segment cap (overrides the preset) |
| `overlapSec` | number | Custom inter-segment overlap (overrides the preset) |
| `outputDir` | string | Directory to write the filmstrip to; no filmstrip if empty |

#### `aivideo_split`

Cuts the video and generates the workflow bundle. **This is the only step that writes files.**

On top of `aivideo_analyze`, it adds:

| Parameter | Type | Description |
| --- | --- | --- |
| `outputDir` | string | Output directory; if empty, uses "video's directory/`<filename>-shotkit-<timestamp>`" |
| `mode` | string | `reencode` (default) or `copy` |
| `quality` | string | `high` / `balanced` / `fast` / `lossless` |
| `only` | string | Export only the given shot numbers, e.g. `"1,3,5"` |
| `minVerdict` | string | Export only shots scoring at least this grade: `excellent` / `good` / `fair` |
| `segment` | boolean | Default true |
| `noBundle` | boolean | Cut clips only, generate no documents |

#### Plugin configuration keys

| Key | Default | Description |
| --- | --- | --- |
| `ffmpegPath` | `''` | Auto-detected if empty |
| `minShotSeconds` | `1.5` | Minimum shot duration |
| `minScore` | `0.3` | Scene score threshold |
| `cropBottomPx` | `0` | Force cropping this many pixels off the bottom every time |
| `sampleTargetFrames` | `1800` | Target number of sampled frames for the per-frame analysis |
| `autoSides` | `false` | Whether to also auto-crop left/right (off by default, to avoid clipping the picture) |
| `registerTools` | `true` | Whether to register the 4 tools |
| `registerSkill` | `true` | Whether to register the skill |

## How it works

```
video ──▶ (1) probe/crop ──▶ (2) frame stats ──▶ (3) shots ──▶ (4) eval ──▶ (5) sub-split ──▶ (6) export
         probe          scene scores    cluster   metrics+group   planSegments   workflow bundle
```

**① Probing and automatic cropping.** The whole video is downsampled at a fixed frame rate into 160×90 grayscale frames, and per row it records "is it almost unchanged frame to frame" and "is it very dark". Those contiguous dark-and-static rows at the bottom/top are the player control strip (not a black bar — it is an overlay on top of the full frame, which `cropdetect` misses). Once detected, it is converted to pixels by frame height and **expanded outward by one extra row** to absorb the anti-aliasing transition.

**② Per-frame statistics.** For each sampled frame it computes brightness, contrast, sharpness (Laplacian variance), saturation, warm-pixel share, and **the per-pixel luma difference against the previous sampled frame**. Motion magnitude is normalized per model frame (1/16 s).

**③ Shot detection.** It takes the whole-video scene-score series and picks cut points with an "isolated spike" criterion — a real cut point is characterized by **a single-frame spike followed by an immediate fall-back**, whereas high-speed motion produces **many consecutive frames held high**. Then the minimum shot duration merges cut points that sit too close together, keeping only the one with the sharper change.

**④ Per-shot evaluation.** It aggregates motion magnitude, motion coverage (what fraction of the picture is moving), flicker rate, sharpness, exposure, and duration, weights them into a "replaceability" score and verdict, and maps that onto four workflow groups.

**⑤ Sub-segmentation.** When a shot is longer than its group's window it is divided evenly: `段数 = max(2, ceil((时长-重叠)/(窗口-重叠)))`, each segment exactly window-length, the first anchored at 0 and the last anchored at the end, adjacent segments overlapping by a fixed number of seconds (the overlap grows slightly with the segment count; the actual value is written to `segments[].overlapWithPrev`).

**⑥ Export.** Cut segment by segment (`reencode` is frame-accurate; `copy` is lossless but snaps cut points to keyframes), then write out the clips and the workflow bundle.

## The numbers behind the parameters (all sourced)

### Sub-segment window presets

| Preset | Per-segment cap | Min segment | Overlap | Applies to |
| --- | --- | --- | --- | --- |
| `cloud` (default) | 15s | 3s | 1.0s | Wan Animate API / Kling / Viggle / Runway |
| `opensource` | 5s | 2s | 1.0s | ComfyUI `WanAnimate2ToVideo` / VACE |
| `tight` | 2s | 1s | 0.5s | Conservative setting for severe identity drift |

### Per-call windows of the various tools (the basis for choosing a window)

| Tool | Per-call window | Source |
| --- | --- | --- |
| Wan2.2 Animate API | Reference video **2–30s**, dimensions 200–2048px | [Alibaba Cloud Model Studio docs](https://www.alibabacloud.com/help/en/model-studio/wan-animate-move-api) |
| ComfyUI `WanAnimate2ToVideo` | `length=81` frames @16fps ≈ **5.06s** | [ComfyUI built-in node docs](https://docs.comfy.org/built-in-nodes/WanAnimate2ToVideo) |
| VACE / Wan2.1 | **81 frames** @16fps (1.3B 480×832 / 14B 720×1280) | [ali-vilab/VACE](https://github.com/ali-vilab/VACE) |
| Runway Act-Two | **3–30s, 24fps**; officially requires "no cuts that interrupt the shot" | [Runway Help Center](https://help.runwayml.com/hc/en-us/articles/42311337895827) |
| Kling | 3.0 series **3–15s**; O1/2.6 **3–10s**; 2.5 Turbo only 5s or 10s | [Kling capability map](https://kling.ai/document-api/guides/capability-map/video.md) |
| Viggle | Driving video **5–15s** | [Viggle pricing docs](https://docs.viggle.ai/v1/pricing) |
| LivePortrait | Driving video cropped to **1:1** (512×512 or 256×256) | [KwaiVGI/LivePortrait](https://github.com/KwaiVGI/LivePortrait) |
| MimicMotion | 72 frames @576×1024 | [Tencent/MimicMotion](https://github.com/Tencent/MimicMotion) |
| UniAnimate | 32 frames, `context_overlap` defaults to 8, recommends 16 when drifting | [ali-vilab/UniAnimate](https://github.com/ali-vilab/UniAnimate) |

### Motion magnitude buckets

The unit is **the average luma difference per model frame (1/16 s)** (0–255 grayscale). Model frames rather than source frames are used as the denominator so that 24fps / 30fps / 60fps footage can be compared with each other.

| Bucket | Threshold | Suggested strategy |
| --- | --- | --- |
| still | `< 1` | Grab a frame → swap the character → regenerate motion (two-step, highest success rate) |
| subtle motion | `1 – 4` | First choice for face swap (LivePortrait / LatentSync) |
| moderate motion | `4 – 12` | Motion transfer (Wan Animate / VACE) |
| intense motion | `≥ 12` | Cut shorter to 1–2s first, do optical-flow stabilization, then transfer |

### Stitching rules

The two endpoints of the overlap interval are exactly the moments where the two sides are least consistent, so **switch at the midpoint of the overlap**; `xfade` uses 1.0s (the ffmpeg default); before stitching, all segments must be normalized to the same resolution/pixel format/frame rate/timebase; when using the concat filter you **must write `a=1` explicitly** for the audio track to be carried.

## Capability limits

This section is deliberately detailed. A tool's value depends on whether you can trust its output, so the things that don't hold are spelled out here too.

| Item | The actual situation |
| --- | --- |
| Face detection | **None.** If you want to judge "is the face visible", wire up YuNet (MIT, commercially usable) or another detector yourself. |
| Shot scale | **Not measurable.** We once tried to infer "close-up / full-body" from motion coverage and it failed outright on one real piece of footage: `#10` was a close-up yet computed as 9%, and `#11` was a distant full-body shot yet computed as 23%. That field has been deleted and replaced with the neutral "whole-frame / partial / local motion". For scale, confirm visually against `filmstrip.jpg`. |
| Warm/skin-tone share | Just a picture-statistics heuristic; it runs high overall in warm-lit interiors. **Only usable for relative ordering.** |
| Crop precision | Strip detection runs on a 160×90 grid, so precision is about ±1 grid row (≈ 1/90 of the frame height). On 1440p footage that is ±16px; when you need an exact value, specify it manually with `--crop-bottom`. |
| Motion magnitude invariance | It is based on luma difference, so fades, white flashes, and violent lighting changes are read as "motion". |
| Transitions other than hard cuts | Dissolves/wipes get assigned to one side, and may shift the shot boundary by several frames. |
| `--mode copy` | ffmpeg's `-c copy` snaps cut points to the nearest keyframe and is **not frame-accurate**; a shot's start/end may be off by seconds (depending on GOP length). Use `--mode reencode` (the default) when you need precision. |

**How it performed on one real piece of footage** (2560×1440 @60fps, bilibili player picture recorded with OBS, 61 seconds):

```
自动裁切    2560x1440 → 2560x1360+0+0（检出底部 80px 控件条）
分镜        20 个镜头，平均 3.054s，中位 2.85s
子分段      31 个可投喂片段（9 个镜头因超长被切分）
评估        16 个判定为可直接用于替换
```

The raw `select='gt(scene,0.25)'` hit **263** time points on that same footage in a single pass (the 25.0–28.4s interval alone packed in about 50) — that is why the clustering post-processing is necessary.

## License red lines

**This repository's code is MIT, but some of the models it recommends are not.** If commercial use is involved, be sure to read this section.

✅ **Commercially usable**

- VACE / Wan2.1 — Apache-2.0
- LivePortrait — MIT
- Champ — MIT
- YuNet (face detection, OpenCV Zoo) — MIT, and detects faces from 10×10 up to 300×300

⛔ **Non-commercial research only**

- `insightface` / `buffalo_l` / `inswapper_128.onnx` / `inswapper_128_fp16.onnx` / `codeformer-v0.1.0.pth`
- As of **2025-11-24**, the official channel requires contacting them for a commercial license: `recognition-oss-pack@insightface.ai`
- Note that SCRFD's **code** is MIT, but the **weights** it uses (DWPose / buffalo_l training data) are marked "available for non-commercial research purposes only", so the weights likewise cannot be used commercially

⚠️ **Also**: when a **real person's** likeness is involved, whatever model you use, please confirm you have that person's authorization; the terms of service of many cloud services explicitly require this too. This tool only does technical preprocessing and provides no legal advice.

## FAQ

**Q: I get `not a decodable video` / ffmpeg not found?**
Run `node bin/shotkit.mjs probe "<your-video>"` first and look at the probe result. When ffmpeg cannot be found, point at the executable with `--ffmpeg-path` or by setting the environment variable `AIVIDEO_FFMPEG`.

**Q: Shots are cut too finely / too few?**
Adjust `--min-score` (default 0.3). Lower cuts more, higher merges more. Also look at `--min-shot` (default 1.5 seconds) — cut points that sit too close together keep one of them by score.

**Q: Why are there more clips than shots?**
Because over-long shots were sub-segmented. Add `--no-segment` if you want one file per shot.

**Q: The crop cut off a bit of the picture content?**
Strip detection has a quantization error of ±1 grid row. Specify it exactly with `--crop-bottom N`, or don't crop at all with `--no-crop`.

**Q: The clips produced by `--mode copy` have the wrong duration?**
`copy` is not frame-accurate; cut points snap to the nearest keyframe. Switch to `--mode reencode`.

**Q: How long a video can it handle?**
Shot detection and evaluation are per-frame statistics, sampled to about 1800 frames by default, so long videos do not slow down linearly; but cutting time is proportional to the number of clips. For a video tens of minutes long, try cutting a few shots first with `--only`.

**Q: Which formats are supported?**
Anything ffmpeg can decode (mp4 / mov / mkv / webm / avi …). Output is uniformly mp4 (H.264 + AAC).

**Q: I installed it into DSH but don't see the tools?**
A profile's bundle list is assembled **at startup**, so restart DSH after installing. You can also confirm in DSH's plugin manager that it is enabled.

## Development and testing

```bash
# 1) syntax check (all sources)
node --check lib/index.js

# 2) probe end-to-end self-check
node scripts/smoke-probe.mjs "<any-video>"

# 3) host contract test -- run the real lib/index.js against a fake Cordis ctx
node scripts/host-load-test.mjs

# 4) full-pipeline self-check on synthetic footage (needs no real footage)
node scripts/make-demo-video.mjs --out demo/demo.mp4
node bin/shotkit.mjs run demo/demo.mp4 --out demo/out --filmstrip
```

Item 3 deserves a note of its own: `scripts/host-load-test.mjs` constructs a fake Cordis `ctx`, then loads the **real** `lib/index.js` and calls the **real** `defineTool()`. It catches contract problems that only surface in the host — for example "writing `required` inside `output.schema` throws at definition time", which the CLI cannot catch and for which the "install into a profile and restart" feedback loop is too slow. All 51 assertions are currently green.

There are also a few diagnostic scripts under `scripts/`: `dump-rowstats.mjs` (per-row/per-column temporal statistics, for analyzing overlays), `dump-scenes.mjs` (dumps the per-frame scene scores), `motion-diag.mjs` (tells whether motion is real coherent motion or noise/flicker).

## Contributing

Issues and PRs are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first; it sets out the two things this project values most: **zero runtime dependencies**, and **not overstating capabilities**.

## License

[MIT](LICENSE) © 2026 loubaji083-rgb

The code in this repository may be freely used, modified, and distributed; but the third-party models it recommends/integrates with are licensed separately — see [License red lines](#license-red-lines) above.
