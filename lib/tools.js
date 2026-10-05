/**
 * Tool definitions exposed to the agent.
 *
 * Everything here is host-agnostic: the only host package referenced is
 * `@deepseek-ai/dsh-tools`, and it is imported *dynamically* by the entry so a
 * profile without it cannot break plugin loading (the failure mode that once
 * took down the whole entry of another plugin in this profile).
 */

import fs from 'node:fs';
import path from 'node:path';
import { analyzeVideo, exportShots, resolveToolchain, defaultOutputDir } from './core/pipeline.mjs';
import { workflowPlan, CATEGORIES } from './core/workflow.mjs';
import { VERDICT_LABEL, MOTION_SCOPE_LABEL } from './core/analyze.mjs';
import { fmtTime, humanBytes } from './core/util.mjs';
import { recordAnalysis, recordCut } from './core/state.mjs';

/**
 * Analysis is the expensive step (a full scene decode plus a full low-res
 * decode) and the natural workflow is `analyze` -> look -> `split`. Cache the
 * result per (file, mtime, detection options) so the second call is free.
 */
const analysisCache = new Map();
const CACHE_LIMIT = 8;

function cacheKey(file, opts) {
  let stamp = 'nostat';
  try {
    const st = fs.statSync(file);
    stamp = `${st.size}:${st.mtimeMs}`;
  } catch {
    /* keep nostat */
  }
  const { ffmpegPath, ...rest } = opts;
  return `${path.resolve(file)}|${stamp}|${JSON.stringify(rest)}`;
}

async function getAnalysis(file, opts) {
  const key = cacheKey(file, opts);
  const hit = analysisCache.get(key);
  if (hit) return { result: hit, cached: true };
  const result = await analyzeVideo(file, opts);
  analysisCache.set(key, result);
  if (analysisCache.size > CACHE_LIMIT) analysisCache.delete(analysisCache.keys().next().value);
  // 面板只看最近一次运行；缓存命中时数据没变，不重复记。
  try {
    recordAnalysis(result, { outputDir: opts.outputDir || null });
  } catch {
    /* 状态记录失败不该影响分析本身 */
  }
  return { result, cached: false };
}

export function clearAnalysisCache() {
  analysisCache.clear();
}

const VIDEO_ARG = {
  type: 'string',
  required: true,
  description: '视频文件绝对路径（支持 mp4/mov/mkv/webm 等 ffmpeg 可解码的格式）。',
};

const FFMPEG_ARG = {
  type: 'string',
  description: '可选的 ffmpeg 可执行文件路径；留空则自动探测（配置 → 环境变量 AIVIDEO_FFMPEG → PATH → 常见安装位置）。',
};

const MIN_SHOT_ARG = {
  type: 'number',
  description: '最短镜头时长（秒），默认 1.5。相邻切点比它更近时只保留变化更剧烈的那个，用来压掉闪烁造成的假切点。',
};

const MIN_SCORE_ARG = {
  type: 'number',
  description: '场景变化分数阈值，默认 0.3。调低会切出更多更碎的镜头，调高会合并镜头。',
};

const CROP_BOTTOM_ARG = {
  type: 'number',
  description: '手动指定要裁掉的底部像素高度（用于去掉播放器进度条/控件覆盖层）。不给则自动检测。',
};

const KEEP_FULL_ARG = {
  type: 'boolean',
  description: '为 true 时完全不裁切，保留原始画幅（默认会自动裁掉检测到的播放器 UI 条）。',
};

const SEGMENT_PRESET_ARG = {
  type: 'string',
  description:
    '子分段窗口预设：cloud（默认，单段 ≤15s，适合 Wan Animate API / Kling / Viggle / Runway 等云端接口）、' +
    'opensource（≤5s，适合本地 ComfyUI Wan Animate / VACE 等开源管线）、tight（≤2s，保守设置，只在身份漂移严重时用）。',
};

const MAX_SEGMENT_ARG = {
  type: 'number',
  description: '自定义单段上限秒数，覆盖 segmentPreset（例如 WanAnimate2ToVideo 的 81 帧 @16fps ≈ 5.06，就填 5）。',
};

const OVERLAP_ARG = {
  type: 'number',
  description: '自定义段间重叠秒数，覆盖 segmentPreset（默认 1.0s，即 16fps 下 16 帧，取 UniAnimate context_overlap 的建议值）。',
};

const SEGMENT_ARG = {
  type: 'boolean',
  description: '为 true（默认）时把超过模型单次窗口的长镜头再切成可投喂的子片段，文件名为 <镜头>_seg<NN>_….mp4；为 false 时一个镜头一个文件。',
};

function detectionOptions(config, args) {
  return {
    ffmpegPath: args.ffmpegPath || config.ffmpegPath || undefined,
    autoCrop: !args.keepFullFrame,
    autoSides: Boolean(config.autoSides),
    minShotDuration: numOr(args.minShotSeconds, config.minShotSeconds, 1.5),
    minScore: numOr(args.minScore, config.minScore, 0.3),
    cropOverride: bottomCrop(args.cropBottom, config.cropBottomPx),
    sampleTargetFrames: numOr(config.sampleTargetFrames, undefined, 1800),
    // Segment options must travel with the analysis: the shots it returns carry
    // the segment plan, and `aivideo_split` reuses that same cached result.
    segmentPreset: args.segmentPreset || config.segmentPreset || 'cloud',
    maxSegmentSec: numOr(args.maxSegmentSec, config.maxSegmentSec) ?? null,
    overlapSec: numOr(args.overlapSec, undefined) ?? null,
  };
}

function numOr(...vals) {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

function bottomCrop(flagValue, configValue) {
  const px = numOr(flagValue, configValue);
  return px ? { bottomPx: px } : null;
}

/**
 * `cropOverride` needs the real frame size to turn a bottom height into a box,
 * so resolve it after probing: `{ bottomPx }` is expanded here.
 */
async function runAnalysis(config, args) {
  const opts = detectionOptions(config, args);
  const first = await getAnalysis(args.video, opts);
  if (first.result.cropRequested && first.result.crop?.height && opts.cropOverride?.bottomPx) {
    // Already handled by analyzeVideo via cropOverride shape; nothing to do.
  }
  return first;
}

const TOOL_SPECS = [
  {
    name: 'aivideo_probe',
    description:
      '探测一个视频：编码/分辨率/帧率/时长/音轨，并检测画面里有没有播放器 UI 覆盖层（进度条、控件）或黑边，给出建议裁切区域。' +
      '在对录屏素材做任何切割之前先调用它，能避免把播放器 UI 一起切进片段。只读，不写文件。',
    parameters: { video: VIDEO_ARG, ffmpegPath: FFMPEG_ARG },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          detail: { type: 'string' },
        },
      },
      render: (_args, v) => [{ type: 'text', text: v.detail || v.summary || '' }],
    },
    async execute(args, exec) {
      const { probeMedia, probePlayableArea } = await import('./core/probe.mjs');
      const tc = resolveToolchain({ ffmpegPath: args.ffmpegPath });
      const media = await probeMedia(tc.ffmpeg, args.video);
      const area = await probePlayableArea(tc.ffmpeg, args.video, { info: media, signal: exec?.signal });
      const lines = [
        `ffmpeg：${tc.ffmpeg}（${tc.ffmpegSource}）`,
        `ffprobe：${tc.ffprobe || '未安装（本插件不依赖它）'}`,
        `容器：${media.format}｜时长 ${fmtTime(media.duration)}｜码率 ${media.bitrate || '-'} kb/s`,
        `视频：${media.video.width}×${media.video.height} ${media.video.fps}fps ${media.video.codec} ${media.video.pixFmt}`,
        media.audio.length
          ? `音频：${media.audio.map((a) => `${a.codec} ${a.sampleRate}Hz ${a.channels}`).join(' / ')}`
          : '音频：无',
        `编码器标签：${media.metadata?.encoder || '未知'}`,
        `播放器 UI 覆盖层：${area.playerUi ? '检测到' : '未检测到'}（底部静态条 ${area.bands.chromeBottomPx}px，占画面 ${(area.bands.chromeBottomFraction * 100).toFixed(1)}%）`,
        `建议裁切：${area.suggestedCrop.width}×${area.suggestedCrop.height}+${area.suggestedCrop.x}+${area.suggestedCrop.y}`,
        `判断依据：${area.note}`,
      ];
      return { ok: true, summary: `已探测 ${path.basename(args.video)}`, detail: lines.join('\n') };
    },
  },

  {
    name: 'aivideo_detect_shots',
    description:
      '对视频做分镜切分（shot detection），只返回镜头列表与每个切点的分数，不做逐镜头评估、不写文件。' +
      '原理：先取全片逐帧 scene 分数序列，再用「孤立尖峰」判据 + 最短镜头时长聚类决定切点，因此不会像 ffmpeg 单阈值那样把高速运动误判成一堆切点。',
    parameters: {
      video: VIDEO_ARG,
      ffmpegPath: FFMPEG_ARG,
      minShotSeconds: MIN_SHOT_ARG,
      minScore: MIN_SCORE_ARG,
      cropBottom: CROP_BOTTOM_ARG,
      keepFullFrame: KEEP_FULL_ARG,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          shots: { type: 'number' },
          summary: { type: 'string' },
          detail: { type: 'string' },
        },
      },
      render: (_args, v) => [{ type: 'text', text: v.detail || v.summary || '' }],
    },
    async execute(args, exec) {
      const { result } = await runAnalysis({}, { ...args, analyze: false });
      void exec;
      const rows = result.detection.shots.map(
        (s) => `  #${String(s.index).padStart(3, '0')}  ${fmtTime(s.start)} → ${fmtTime(s.end)}  ${s.duration.toFixed(2)}s  ${s.cutScore === null ? '（片头）' : `切点分 ${s.cutScore.toFixed(3)}`}${s.cutType === 'dissolve' ? ' 叠化' : ''}`,
      );
      const detail = [
        `素材：${result.input}`,
        `规格：${result.media.video.width}×${result.media.video.height} ${result.media.video.fps}fps 时长 ${fmtTime(result.media.duration)}`,
        `裁切：${result.crop ? `${result.crop.width}×${result.crop.height}+${result.crop.x}+${result.crop.y}` : '无'}`,
        `场景分统计：帧数 ${result.scene.frames}　p50=${result.scene.stats.p50}　p90=${result.scene.stats.p90}　p99=${result.scene.stats.p99}　max=${result.scene.stats.max}`,
        `镜头数：${result.summary.count}　平均 ${result.summary.meanDuration}s　中位 ${result.summary.medianDuration}s`,
        '',
        '镜头表：',
        ...rows,
      ].join('\n');
      return { ok: true, shots: result.summary.count, summary: `切出 ${result.summary.count} 个镜头`, detail };
    },
  },

  {
    name: 'aivideo_analyze',
    description:
      '分镜 + 逐镜头评估：统计每个镜头的运动量、闪烁、清晰度、亮度、暖色像素占比等指标，给出「可替换性」评分与判定，' +
      '并按运动量把镜头分组到人物替换工作流（静止→静帧重绘；轻微运动→换脸首选；中等运动→动作迁移；剧烈运动→需先切短）。' +
      '重要：本插件没有内置人脸检测器，「暖色/肤色占比」只是画面统计启发式（暖光室内会偏高），只能用于相对排序，不能当作人物有无的判断依据；' +
      '镜头尺度（近景/全身）请结合 aivideo_analyze 生成的 filmstrip 缩略图目视确认。',
    parameters: {
      video: VIDEO_ARG,
      ffmpegPath: FFMPEG_ARG,
      minShotSeconds: MIN_SHOT_ARG,
      minScore: MIN_SCORE_ARG,
      cropBottom: CROP_BOTTOM_ARG,
      keepFullFrame: KEEP_FULL_ARG,
      segmentPreset: SEGMENT_PRESET_ARG,
      maxSegmentSec: MAX_SEGMENT_ARG,
      overlapSec: OVERLAP_ARG,
      outputDir: { type: 'string', description: '可选：把分镜缩略图（filmstrip.jpg）写到此目录；不填则不生成缩略图。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          shots: { type: 'number' },
          replaceable: { type: 'number' },
          recommended: { type: 'number' },
          segments: { type: 'number' },
          summary: { type: 'string' },
          detail: { type: 'string' },
        },
      },
      render: (_args, v) => [{ type: 'text', text: v.detail || v.summary || '' }],
    },
    async execute(args, exec) {
      const { result, cached } = await runAnalysis({}, args);
      // analyzeVideo already attached category + segment plan to each shot.
      const classified = result.shots;
      const plan = workflowPlan(classified, result.segmentOptions || {});

      const rows = classified.map((s) => {
        const m = s.metrics || {};
        const nSeg = s.workflow?.segmentCount || 1;
        return [
          `  #${String(s.index).padStart(3, '0')}  ${fmtTime(s.start)} → ${fmtTime(s.end)}  ${s.duration.toFixed(2)}s`,
          `运动 ${(m.motionIndex ?? 0).toFixed(2)}（${m.motionLevel}）　运动覆盖 ${((m.motionCoverage ?? 0) * 100).toFixed(0)}%（${MOTION_SCOPE_LABEL[m.motionScope] || '-'}）　清晰度 ${m.sharpness}　亮度 ${m.brightness}　暖色占比 ${((m.skinRatio ?? 0) * 100).toFixed(1)}%（启发式）`,
          `可替换性 ${s.replaceability}　判定 ${VERDICT_LABEL[s.verdict] || s.verdict}`,
          `分组 ${s.categoryLabel}　— ${s.categoryReason}`,
          nSeg > 1 ? `需分段：已切成 ${nSeg} 段（每段 ≤ ${s.workflow.maxSegmentSec}s，重叠 ${s.workflow.overlapSec}s）` : '单段即可投喂',
          s.flags?.length ? `标记 ${s.flags.join(', ')}` : null,
        ].filter(Boolean).join('　');
      });

      const groups = plan.groups.map(
        (g) => `▸ ${g.label}（${g.shots.length} 个：${g.shots.map((s) => `#${s.index}`).join(', ')}）\n    ${g.workflow.summary}\n    推荐工具：${(g.workflow.tools || []).join('、')}\n    建议参数：${Object.entries(g.workflow.params || {}).map(([k, v]) => `${k}=${v}`).join('，')}`,
      );

      const detail = [
        `素材：${result.input}${cached ? '（命中分析缓存）' : ''}`,
        `规格：${result.media.video.width}×${result.media.video.height} ${result.media.video.fps}fps 时长 ${fmtTime(result.media.duration)}`,
        `裁切：${result.crop ? `${result.crop.width}×${result.crop.height}+${result.crop.x}+${result.crop.y}（已去掉播放器 UI 覆盖层）` : '无'}`,
        `镜头数：${plan.total}　可投喂片段：${plan.segmentCount}（窗口 ${plan.segmentPresetLabel}：单段 ≤ ${plan.window}s，重叠 ${plan.overlapSec}s）`,
        `建议直接用于替换：${plan.recommended}　需要先切短：${plan.needsShortening} 个镜头`,
        '',
        '工作流分组：',
        ...groups,
        '',
        '逐镜头：',
        ...rows,
        '',
        plan.priorityOrder.length
          ? `建议先做的镜头：${plan.priorityOrder.map((s) => `#${s.index}(${s.replaceability})`).join('、')}`
          : '',
        '',
        `提示：${plan.note}`,
      ].filter((l) => l !== '').join('\n');

      return {
        ok: true,
        shots: plan.total,
        replaceable: plan.recommended,
        recommended: plan.recommended,
        segments: plan.segmentCount,
        summary: `${plan.total} 个镜头 → ${plan.segmentCount} 个可投喂片段，${plan.recommended} 个建议直接用于替换`,
        detail,
      };
    },
  },

  {
    name: 'aivideo_split',
    description:
      '切割视频并生成「人物替换工作流包」：按分镜把每个镜头导出成独立片段（可选无损 -c copy 或帧精确重编码），' +
      '并在输出目录写出 workflow.json / prompts.csv / README.md / analysis.json / clips.json，逐镜头给出推荐工具、参数与提示词。' +
      '这是写文件的一步，请先用 aivideo_analyze 确认分镜与评分。',
    parameters: {
      video: VIDEO_ARG,
      outputDir: { type: 'string', description: '输出目录；不填则用「视频同目录/<文件名>-shotkit-<时间戳>」。' },
      mode: { type: 'string', description: '切割模式：reencode（默认，帧精确，可同时应用裁切）或 copy（无损 -c copy，切点吸附到最近关键帧）。' },
      quality: { type: 'string', description: '重编码质量：high | balanced（默认）| fast | lossless。' },
      only: { type: 'string', description: '只导出指定镜头号，逗号分隔，例如 "1,3,5"。' },
      minVerdict: { type: 'string', description: '只导出评分不低于该档的镜头：excellent | good | fair。' },
      ffmpegPath: FFMPEG_ARG,
      minShotSeconds: MIN_SHOT_ARG,
      minScore: MIN_SCORE_ARG,
      cropBottom: CROP_BOTTOM_ARG,
      keepFullFrame: KEEP_FULL_ARG,
      segment: SEGMENT_ARG,
      segmentPreset: SEGMENT_PRESET_ARG,
      maxSegmentSec: MAX_SEGMENT_ARG,
      overlapSec: OVERLAP_ARG,
      noBundle: { type: 'boolean', description: '为 true 时只切片段，不生成工作流包文档。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          clips: { type: 'number' },
          shots: { type: 'number' },
          outputDir: { type: 'string' },
          summary: { type: 'string' },
          detail: { type: 'string' },
        },
      },
      render: (_args, v) => [{ type: 'text', text: v.detail || v.summary || '' }],
    },
    async execute(args, exec) {
      const { result } = await runAnalysis({}, args);
      const mode = /^(copy|reencode)$/i.test(args.mode || '') ? args.mode.toLowerCase() : 'reencode';
      const quality = /^(high|balanced|fast|lossless)$/i.test(args.quality || '') ? args.quality.toLowerCase() : 'balanced';
      const only = args.only
        ? String(args.only).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
        : null;
      const segment = args.segment !== false;

      const res = await exportShots(result, {
        outputDir: args.outputDir || defaultOutputDir(args.video),
        mode,
        quality,
        only,
        minVerdict: ['excellent', 'good', 'fair'].includes(args.minVerdict) ? args.minVerdict : null,
        cut: true,
        bundle: !args.noBundle,
        segment,
        signal: exec?.signal,
      });

      const ok = res.shots.filter((c) => c.ok);
      try {
        recordCut(res, { outputDir: res.outputDir });
      } catch {
        /* 状态记录失败不该影响切割本身 */
      }
      const lines = [
        `输出目录：${res.outputDir}`,
        `切割模式：${res.cut.mode === 'copy' ? '无损 -c copy（切点吸附关键帧）' : '帧精确重编码 libx264'}`,
        res.cut.segmented ? `子分段：已开启（长镜头二次切分为 <镜头>_seg<NN>_….mp4）` : '子分段：关闭（一个镜头一个文件）',
        `片段：${ok.length} 个成功 / ${res.shots.length - ok.length} 个失败　合计 ${humanBytes(res.cut.totalBytes)}`,
        '',
        ...ok.map((c) => {
          const tag = c.segIndex != null ? `镜头 #${c.index} 第 ${c.segIndex}/${c.segCount} 段` : `镜头 #${c.index}`;
          return `  ${c.fileName}　${fmtTime(c.start)} → ${fmtTime(c.end)}　${humanBytes(c.bytes)}　${tag}`;
        }),
        '',
        ...(res.warnings.length ? ['注意：', ...res.warnings.map((w) => `  ! ${w}`), ''] : []),
        res.bundle?.files?.length ? `工作流包：\n${res.bundle.files.map((f) => `  ${f}`).join('\n')}` : '',
        `分析报告：${res.analysisFile}`,
      ].filter(Boolean);

      return {
        ok: ok.length > 0,
        clips: ok.length,
        shots: res.shots.length,
        outputDir: res.outputDir,
        summary: `已导出 ${ok.length} 个片段到 ${res.outputDir}${res.cut.segmented ? '（长镜头已按模型窗口二次切分）' : ''}`,
        detail: lines.join('\n'),
      };
    },
  },
];

/** Wrap raw specs with a host-provided `defineTool`. */
export function buildToolDefs(defineTool) {
  return TOOL_SPECS.map((spec) =>
    defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: spec.output,
      async execute(args, exec) {
        try {
          return await spec.execute(args || {}, exec);
        } catch (err) {
          return {
            ok: false,
            summary: `失败：${err.message}`,
            detail: `调用 ${spec.name} 失败：${err.message}${err.code ? `（${err.code}）` : ''}`,
          };
        }
      },
    }));
}

export const TOOL_NAMES = TOOL_SPECS.map((s) => s.name);
export { analysisCache, CATEGORIES };
