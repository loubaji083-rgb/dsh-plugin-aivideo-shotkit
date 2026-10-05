# 贡献指南

感谢愿意花时间。这个项目有两条不可让步的原则，先说在前面：**零运行时依赖**，以及**不夸大能力**。

## 两条硬原则

### 1. 零运行时依赖

`package.json` 里**不能出现 `dependencies`**。

核心逻辑只允许用 Node 内置模块：`node:child_process`、`node:fs`、`node:path`、`node:os`、`node:url`，加上 `Float32Array` / `Int16Array` 这类 typed array。

原因不是洁癖，而是这个工具的定位：它要能在一个只有 Node + ffmpeg 的机器上、离线、以一条命令跑起来。一旦引入 `opencv` / `onnxruntime` / `numpy`，它就不再是"随手能跑的前处理脚本"，而变成一个需要配环境的项目了。

如果你需要某个能力必须依赖外部库，正确做法是：**把它做成可选的外部步骤并在文档里写清楚**，而不是加进 `dependencies`。

### 2. 不夸大能力

这是从一次真实的翻车里定下来的规矩。

项目早期曾经输出过一个 `scaleHint` 字段，用「运动覆盖率」反推镜头是近景还是全身。拿真实素材和缩略图一对照就崩了：一个是近景却算出 9%（判成远景），一个是远景全身却算出 23%（判成近景）。这个字段被整个删掉，换成了中性的「整幅/部分/局部运动」。

所以：

- **能测的说能测，测不了的说测不了。** 运动量是像素级统计，可靠；"画面里有没有人""脸可不可见""近景还是全身"测不了，就不做字段。
- **启发式要标注成启发式。** 例如「暖色/肤色占比」，描述里必须写明它只是画面统计、暖光室内会偏高、只能用于相对排序。
- **不要为了结论好看而调阈值。** 如果一份素材客观上就是 19/20 个镜头剧烈运动，那就输出 19/20，不要为了让分类分布好看去改分档。

PR 里如果新增了指标或判定，请一并给出**你在什么素材上验证过、结论是什么、有没有反例**。

## 开发环境

```bash
git clone https://github.com/loubaji083-rgb/dsh-plugin-aivideo-shotkit.git
cd dsh-plugin-aivideo-shotkit
node --version        # 需要 ^22.19.0 || >=24.0.0
ffmpeg -version       # 需要一个可用的 ffmpeg（不要求 ffprobe）
```

不需要 `npm install`——没有依赖。

## 目录结构

```
lib/core/        纯逻辑，与 DSH 无关，可单独 import
  ffmpeg.mjs     ffmpeg 探测与进程封装（永远 resolve、不 reject）
  probe.mjs      元数据解析 + 覆盖层/黑边检测
  frames.mjs     抽帧、缩略图、像素工具
  shots.mjs      scene 分数序列 → 切点聚类
  analyze.mjs    逐镜头指标与评分
  segments.mjs   子分段数学（纯函数，最容易写测试）
  workflow.mjs   分组与工作流编排
  tools-catalog.mjs 所有外部数字的唯一来源（含出处 URL）
  split.mjs      切割
  bundle.mjs     工作流包导出
  state.mjs      进程内状态（状态灯，不是数据库）
lib/index.js     DSH 宿主入口（注册工具/技能/路由）
lib/tools.js     4 个原生工具的定义
lib/client.js    浏览器端面板（注意：不是裸 ESM，见下）
bin/shotkit.mjs  CLI
skills/          技能文档
scripts/         自检与诊断脚本
```

## 跑测试

```bash
node --check lib/index.js                   # 语法
node scripts/host-load-test.mjs             # 宿主契约（51 项断言）
node scripts/make-demo-video.mjs --out demo/demo.mp4
node bin/shotkit.mjs run demo/demo.mp4 --out demo/out --filmstrip
```

**改动 `lib/tools.js` 后一定要跑 `scripts/host-load-test.mjs`。** 它用假的 Cordis `ctx` 跑真实的 `lib/index.js`，并调用真实的 `defineTool()`。有两个契约只有在真实宿主里才会暴露：

1. **`required` 要写在参数属性上**，`defineTool()` 会把它规范成顶层 JSON Schema 的 `required: [...]`。（反过来，在 `output.schema` 里写 `required` 会直接抛错：`unsupported JSON schema: schema.required is not supported by the value schema DSL`。）
2. **`output.render` 是必需的**，不给会抛 `TypeError: Cannot read properties of undefined (reading 'render')`。

这两条 CLI 都测不出来，而"装进 profile 再重启"的反馈回路又太长，所以有了这个 harness。

`scripts/host-load-test.mjs` 需要能 `import('@deepseek-ai/dsh-tools')`。如果你在本地源码目录跑，可以在 `node_modules/@deepseek-ai` 建一个指向 DSH profile 的 junction：

```powershell
cmd /c mklink /J node_modules\@deepseek-ai "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai"
```

用完删的时候**别用 `Remove-Item -Recurse`**（PowerShell 会跟随 junction 把目标内容一起删掉），用 `cmd /c rmdir node_modules\@deepseek-ai`。

## 代码风格

- ESM，`.mjs`（核心与 CLI）或 `.js` + `"type": "module"`（插件入口）。
- 注释写**为什么**，不写**是什么**。尤其是那些踩过坑的地方——本项目里最有价值的注释都是"为什么不能用更直观的写法"。
- 面向用户的字符串用中文（作者母语、目标用户以中文为主）；标识符、日志键、JSON 字段用英文。
- 错误信息要能直接指向下一步动作，例如 `原生工具未启用（无法取得 defineTool：…）——CLI 与技能不受影响`。
- 长任务要支持取消：`execute(args, exec)` 里的 `exec.signal` 要透传到 `run()`。

## 特殊文件注意事项

- **`lib/client.js` 不是裸 ESM。** 它是宿主 loader 抓取的文件，必须是 `window.__ModuleLoader__.load({ id, factory })` 这种包装形态，内部用 `require('react')`，不能写 `import`。
- **`lib/core/ffmpeg.mjs` 的 `run()` 永远 resolve、不 reject。** 这是刻意的：沙箱里 `spawn` 可能同步抛 EPERM，调用方需要拿到 `spawnError` 才能给出有用的提示。改动这里要同步检查所有调用点。
- **`tools-catalog.mjs` 是外部数字的唯一来源。** 新增/修改任何"某工具支持多长"的数字，都要带 `source` URL，并在这里改，不要在别处硬编码。

## 提交与 PR

- 提交信息用 `type: 简述` 的形式（`feat` / `fix` / `docs` / `refactor` / `test` / `chore`）。
- PR 描述里请写：**改了什么、为什么、怎么验证的**。涉及用户可见行为变化的，请贴出改动前后的实际输出。
- 新增能力请补上对应的自检；不能自动验证的，请在 PR 里说明你是手工怎么验证的。

## 报告问题

提 issue 时请附上：

- `node bin/shotkit.mjs probe "<你的视频>"` 的输出（它会打印编码/分辨率/帧率/检测到的覆盖层）
- 操作系统、Node 版本、`ffmpeg -version` 第一行
- 你用的命令和完整报错

**请勿上传他人视频。** 需要复现素材的话，用 `node scripts/make-demo-video.mjs` 现造一段，或者描述素材特征（分辨率、帧率、是不是录屏、有没有硬切）。
