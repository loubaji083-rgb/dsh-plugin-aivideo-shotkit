#!/usr/bin/env node
/**
 * shotkit CLI — the same core the DSH plugin exposes as tools, usable from a
 * plain shell. Zero npm dependencies; ffmpeg is discovered on the machine.
 *
 *   node bin/shotkit.mjs probe    <video>
 *   node bin/shotkit.mjs shots    <video> [--min-shot 1.5]
 *   node bin/shotkit.mjs analyze  <video> [--out DIR] [--filmstrip]
 *   node bin/shotkit.mjs cut      <video> [--out DIR] [--mode copy|reencode] [--only 1,3,5]
 *   node bin/shotkit.mjs run      <video> [--out DIR] [--mode copy|reencode] [--no-analyze]
 */
import path from 'node:path';
import process from 'node:process';
import { ensureDir, fmtTime, humanBytes, slug } from '../lib/core/util.mjs';
import { extractFrame, buildContactSheet } from '../lib/core/frames.mjs';
import { resolveToolchain, analyzeVideo, exportShots, defaultOutputDir } from '../lib/core/pipeline.mjs';
import { VERDICT_LABEL, MOTION_SCOPE_LABEL } from '../lib/core/analyze.mjs';
import { describeCutResult } from '../lib/core/split.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const input = argv[1];

function flag(name, dflt = false) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) return true;
  }
  return dflt;
}
function opt(name, dflt = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) return true;
  return next;
}
function num(name, dflt) {
  const v = opt(name);
  return v === undefined || v === true ? dflt : Number(v);
}
function list(name) {
  const v = opt(name);
  if (!v || v === true) return null;
  return String(v).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
}

const USAGE = `shotkit — AI 视频分镜切割 / 人物替换工作流划分

用法:
  shotkit probe   <视频>            探测编码、时长、播放器 UI 覆盖层与建议裁切
  shotkit shots   <视频>            只做镜头切分（打印分镜表）
  shotkit analyze <视频>            分镜 + 逐镜头可替换性评估 [--filmstrip]
  shotkit cut     <视频>            切割导出 [--out DIR] [--mode copy|reencode]
  shotkit run     <视频>            全流程：分析 + 切割 + 工作流包

通用选项:
  --out DIR        输出目录（默认 <视频同目录>/<名字>-shotkit-<时间戳>）
  --mode MODE      reencode（默认，帧精确）或 copy（无损，需吸附关键帧）
  --quality P      high | balanced(默认) | fast | lossless
  --min-shot SEC   最短镜头时长，默认 1.5
  --min-score N    场景分数阈值，默认 0.3
  --only LIST      只导出指定镜头号，如 1,3,5
  --min-verdict V  只导出评分不低于 V 的镜头：excellent|good|fair
  --no-crop        不裁掉播放器 UI 覆盖层
  --crop-bottom N  手动指定底部裁掉像素数
  --segment        把超过模型单次窗口的长镜头再切成可投喂的子片段（默认开启）
  --no-segment     关闭子分段：一个镜头一个文件
  --segment-preset P  cloud(默认,≤15s) | opensource(≤5s) | tight(≤2s)
  --max-segment N  自定义单段上限秒数（覆盖 preset）
  --min-segment N  自定义最短段秒数（默认取 preset）
  --overlap N      自定义段间重叠秒数（默认取 preset）
  --filmstrip      生成分镜缩略图拼版（analysis 命令）
  --json           以 JSON 输出（probe/shots/analyze）

示例:
  node bin/shotkit.mjs run "<视频路径>" --filmstrip          # 推荐：分析 + 切割 + 工作流包
  node bin/shotkit.mjs run "<视频路径>" --mode copy          # 无损切割（切点吸附关键帧）
  node bin/shotkit.mjs run "<视频路径>" --segment-preset opensource --mode reencode
`;

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(USAGE);
  process.exit(input ? 0 : 0);
}
if (!input || input.startsWith('--')) {
  console.error(USAGE);
  process.exit(2);
}

const jsonOut = flag('json');
const noCrop = flag('no-crop');
const cropBottom = num('crop-bottom', null);

const common = {
  minShotDuration: num('min-shot', 1.5),
  minScore: num('min-score', 0.3),
  autoCrop: !noCrop,
  extraBottom: 0,
};

/** Segment options travel together from analyze → cut so the report and the
 *  files on disk always describe the same subdivision. */
function segmentOpts() {
  const preset = opt('segment-preset');
  return {
    segment: !flag('no-segment'),
    segmentPreset: preset && preset !== true ? String(preset) : 'cloud',
    maxSegmentSec: num('max-segment', null),
    minSegmentSec: num('min-segment', null),
    overlapSec: num('overlap', null),
  };
}

function resolveOutputDir() {
  const out = opt('out');
  if (out && out !== true) return path.resolve(out);
  return defaultOutputDir(input);
}

async function probeCrop(ffmpegPath) {
  const area = await (await import('../lib/core/probe.mjs')).probePlayableArea(
    resolveToolchain({ ffmpegPath }).ffmpeg,
    input,
    { autoCrop: !noCrop, extraBottom: 0 },
  );
  return area;
}

function cropOverrideFromFlags(media, area) {
  if (cropBottom) {
    const h = Math.max(2, media.video.height - Number(cropBottom));
    return { x: 0, y: 0, width: media.video.width, height: h - (h % 2) };
  }
  return null;
}

async function cmdProbe() {
  const tc = resolveToolchain();
  const { probeMedia, probePlayableArea } = await import('../lib/core/probe.mjs');
  const media = await probeMedia(tc.ffmpeg, input);
  const area = await probePlayableArea(tc.ffmpeg, input, { info: media, autoCrop: !noCrop });
  const out = { toolchain: tc, media, area };
  if (jsonOut) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`ffmpeg      : ${tc.ffmpeg} (${tc.ffmpegSource})`);
  console.log(`ffprobe     : ${tc.ffprobe || '未安装（不影响使用）'}`);
  console.log(`容器        : ${media.format}  时长 ${fmtTime(media.duration)}  大小 ${media.sizeBytes ? humanBytes(media.sizeBytes) : '未知'}`);
  console.log(`视频        : ${media.video.width}x${media.video.height}  ${media.video.fps}fps  ${media.video.codec}  ${media.video.pixFmt}`);
  if (media.audio.length) console.log(`音频        : ${media.audio[0].codec}  ${media.audio[0].sampleRate}Hz  ${media.audio[0].channels}`);
  console.log(`编码器标签  : ${media.metadata.encoder || '-'}`);
  console.log(`播放器 UI   : ${area.playerUi ? '检测到' : '未检测到'}（底部静态条 ${area.bands.chromeBottomPx}px，占比 ${(area.bands.chromeBottomFraction * 100).toFixed(1)}%）`);
  console.log(`建议裁切    : ${area.suggestedCrop.width}x${area.suggestedCrop.height}+${area.suggestedCrop.x}+${area.suggestedCrop.y}`);
  console.log(`说明        : ${area.note}`);
}

async function cmdShots() {
  const r = await analyzeVideo(input, { ...common, analyze: false });
  if (jsonOut) {
    console.log(JSON.stringify({ summary: r.summary, shots: r.shots, scene: r.scene, crop: r.crop }, null, 2));
    return;
  }
  printHeader(r);
  printShotTable(r.shots);
  console.log(`\n${JSON.stringify(r.summary)}`);
}

async function cmdAnalyze() {
  const seg = segmentOpts();
  const r = await analyzeVideo(input, { ...common, analyze: true, ...seg });
  // analyzeVideo already attached categories + segment plans; re-classifying
  // here would produce a plan that disagrees with what `cut` will write.
  const classified = r.shots;
  if (jsonOut) {
    console.log(JSON.stringify({ summary: r.summary, shots: classified, crop: r.crop, scene: r.scene, segmentOptions: r.segmentOptions }, null, 2));
    return;
  }
  printHeader(r);
  printShotTable(classified, { verbose: true });
  console.log('\n工作流分组：');
  for (const g of groupShots(classified)) {
    console.log(`  ${g.label} (${g.shots.length} 个镜头): ${g.shots.map((s) => `#${s.index}`).join(', ')}`);
    console.log(`     → ${g.workflow.summary}`);
  }
  const segShots = classified.filter((s) => (s.segments?.count || 1) > 1);
  const totalSeg = classified.reduce((a, s) => a + (s.workflow?.segmentCount || 1), 0);
  console.log(`\n子分段    : 窗口 ${r.segmentOptions?.segmentPreset || 'cloud'}  共 ${totalSeg} 个片段（${segShots.length} 个镜头被切分）`);
  if (flag('filmstrip')) {
    const out = resolveOutputDir();
    ensureDir(out);
    const file = await buildFilmstrip(r, path.join(out, 'filmstrip.jpg'));
    console.log(`\n分镜缩略图: ${file}`);
  }
}

async function cmdCut() {
  const seg = segmentOpts();
  const r = await analyzeVideo(input, { ...common, analyze: true, ...seg });
  const res = await exportShots(r, {
    outputDir: resolveOutputDir(),
    mode: opt('mode', 'reencode'),
    quality: opt('quality', 'balanced'),
    only: list('only'),
    minVerdict: opt('min-verdict', null),
    cut: true,
    bundle: true,
    ...seg,
  });
  printExport(res);
}

async function cmdRun() {
  const out = resolveOutputDir();
  const noAnalyze = argv.includes('--no-analyze');
  const seg = segmentOpts();
  const r = await analyzeVideo(input, { ...common, analyze: !noAnalyze, ...seg });
  const res = await exportShots(r, {
    outputDir: out,
    mode: opt('mode', 'reencode'),
    quality: opt('quality', 'balanced'),
    only: list('only'),
    minVerdict: opt('min-verdict', null),
    cut: true,
    bundle: true,
    ...seg,
    onProgress: (p) => {
      if (p.phase === 'cut') process.stderr.write(`\r切割 ${p.index + 1}/${p.total} ...`);
    },
  });
  process.stderr.write('\r');
  printExport(res);
  if (flag('filmstrip')) {
    ensureDir(out);
    const file = await buildFilmstrip(r, path.join(out, 'filmstrip.jpg'));
    console.log(`\n分镜缩略图: ${file}`);
    console.log('（尺度的唯一可信来源：对着它目视确认每个镜头是近景还是全身，再决定走换脸还是整身替换）');
  }
}

function printHeader(r) {
  console.log(`素材   : ${r.input}`);
  console.log(`规格   : ${r.media.video.width}x${r.media.video.height} ${r.media.video.fps}fps ${fmtTime(r.media.duration)}`);
  console.log(`裁切   : ${r.crop ? `${r.crop.width}x${r.crop.height}+${r.crop.x}+${r.crop.y}` : '无（保留原画幅）'}`);
  console.log(`场景分 : 帧数 ${r.scene.frames}  p50=${r.scene.stats.p50} p90=${r.scene.stats.p90} p99=${r.scene.stats.p99} max=${r.scene.stats.max}`);
  console.log(`镜头数 : ${r.summary.count}  平均 ${r.summary.meanDuration}s  中位 ${r.summary.medianDuration}s\n`);
}

function printShotTable(shots, { verbose = false } = {}) {
  const head = verbose
    ? '  #     起止                    时长   运动量  覆盖   暖色*   评分   分段   判定'
    : '  #     起止                    时长   切点分';
  console.log(head);
  for (const s of shots) {
    const range = `${fmtTime(s.start)} → ${fmtTime(s.end)}`;
    if (!verbose) {
      console.log(`  ${String(s.index).padStart(3, '0')}   ${range.padEnd(24)} ${s.duration.toFixed(2)}s  ${s.cutScore === null ? '  -  ' : s.cutScore.toFixed(3)}`);
      continue;
    }
    const m = s.metrics || {};
    const nSeg = s.workflow?.segmentCount || 1;
    console.log(
      `  ${String(s.index).padStart(3, '0')}   ${range.padEnd(24)} ${s.duration.toFixed(2)}s  ` +
      `${(m.motionIndex ?? 0).toFixed(2).padStart(6)}  ${((m.motionCoverage ?? 0) * 100).toFixed(0).padStart(3)}%  ` +
      `${((m.skinRatio || 0) * 100).toFixed(1).padStart(5)}%  ` +
      `${s.replaceability?.toFixed(3) ?? ' - '}  ${(nSeg > 1 ? `${nSeg} 段` : ' 整段').padStart(5)}  ${s.verdict || ''}`,
    );
    if (s.category) console.log(`        └ ${s.categoryLabel}　${MOTION_SCOPE_LABEL[m.motionScope] || ''}${s.flags?.length ? `  [${s.flags.join(', ')}]` : ''}`);
  }
}

function groupShots(shots) {
  const map = new Map();
  for (const s of shots) {
    const key = s.category || 'unknown';
    if (!map.has(key)) map.set(key, { key, label: s.categoryLabel, workflow: s.workflow, shots: [] });
    map.get(key).shots.push(s);
  }
  return [...map.values()];
}

async function buildFilmstrip(r, outFile) {
  const tc = resolveToolchain();
  const tmpDir = path.join(path.dirname(outFile), '.frames');
  ensureDir(tmpDir);
  const files = [];
  for (const s of r.shots.slice(0, 48)) {
    const t = s.start + Math.min(s.duration * 0.5, Math.max(0, s.duration / 2));
    const f = path.join(tmpDir, `f${String(s.index).padStart(3, '0')}.jpg`);
    await extractFrame(tc.ffmpeg, r.input, t, f, { crop: r.crop, quality: 4 });
    files.push(f);
  }
  await buildContactSheet(tc.ffmpeg, files, outFile, { cols: Math.min(4, Math.ceil(Math.sqrt(files.length))), tileWidth: 480 });
  return outFile;
}

function printExport(res) {
  const d = describeCutResult(res.cut);
  console.log(`输出目录 : ${res.outputDir}`);
  console.log(`切割模式 : ${d.mode === 'copy' ? '无损（-c copy，切点吸附关键帧）' : '精确重编码（libx264）'}`);
  console.log(`成功/失败: ${d.clips} / ${d.failed}   总大小 ${d.totalBytes}`);
  if (d.segmented) console.log('子分段   : 已开启（长镜头被二次切分，文件名为 <shot>_seg<NN>_…）');
  for (const w of d.warnings) console.log(`  ! ${w}`);
  console.log('');
  for (const f of d.files) {
    const tag = f.seg != null ? `镜头 #${f.shot} 第 ${f.seg} 段` : `镜头 #${f.shot ?? f.index}`;
    console.log(`  ${f.file}   ${f.from} → ${f.to}   ${f.size}   ${tag}`);
  }
  if (res.bundle?.files?.length) {
    console.log('\n工作流包:');
    for (const f of res.bundle.files) console.log(`  ${f}`);
  }
  console.log(`\n分析报告 : ${res.analysisFile}`);
}

const COMMANDS = { probe: cmdProbe, shots: cmdShots, analyze: cmdAnalyze, cut: cmdCut, run: cmdRun };
const fn = COMMANDS[cmd];
if (!fn) {
  console.error(`未知命令: ${cmd}\n`);
  console.error(USAGE);
  process.exit(2);
}
try {
  await fn();
} catch (err) {
  console.error(`\n错误: ${err.message}`);
  if (process.env.SHOTKIT_DEBUG) console.error(err.stack);
  process.exit(1);
}
void probeCrop;
void cropOverrideFromFlags;
void VERDICT_LABEL;
void slug;
