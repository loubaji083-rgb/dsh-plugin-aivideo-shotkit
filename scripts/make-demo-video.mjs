#!/usr/bin/env node
/**
 * 生成一段**完全合成**的演示视频，用来演示与自测这套流水线。
 *
 * 为什么要有这个脚本：
 *   真实素材（尤其是别人视频的录屏）有版权，不能进仓库；而「拿一个真视频跑一遍」
 *   又确实是唯一能说明问题的验证。所以这里用 ffmpeg 的 lavfi 源现造一段，
 *   它刻意模仿了本插件最主要的应用场景——**带播放器控件条的录屏**。
 *
 * 造出来的东西长这样（640x388）：
 *   上面 640x360：6 个场景，每场 3 秒，「静态色块」和「带运动的测试图」交替
 *                 → 既能演示镜头切换，也能演示运动量这一维（应有 3 个静止 + 3 个运动）。
 *   下面 640x28 ：一条**逐帧完全静止**的深色条，上面有进度条和按钮形状
 *                 → 用来验证「自动识别并裁掉播放器 UI 覆盖层」。
 *
 * 用法：
 *   node scripts/make-demo-video.mjs [--out demo/demo.mp4] [--force]
 */

import { resolveFfmpeg, runFfmpeg, ffmpegVersion } from '../lib/core/ffmpeg.mjs';
import { ensureDir, exists, humanBytes, fileSize } from '../lib/core/util.mjs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const W = 640;
const H = 360;
const BAR = 28;
const FPS = 30;
const SCENE_SECONDS = 3;
const SCENES = 6;

/**
 * 六个场景的规格，刻意做成「静态 / 运动」交替：
 *   flat   —— 纯色 + 网格纹理 + 静态噪声，逐帧几乎不变（用来演示"静止镜头"）
 *   motion —— testsrc2 测试图，本身带持续运动（用来演示"运动量"这一维）
 *
 * 两点经验（都是踩出来的，写在这里免得后人再踩）：
 *  1. **相邻场景必须拉开「亮度」差，不能只换色相。** ffmpeg 的 `scene` 分数由亮度差主导；
 *     最初用六种亮度都在 25~41 的暗色，6 个硬切一个都没检出（实测 max 仅 0.1616）。
 *  2. **`drawbox` 的 x/y 表达式在这份 ffmpeg 构建里不会逐帧重新求值。**
 *     `x='mod(t*60,200)'` 和 `x='t*60'` 实测都是静止的（逐帧差 max 0.0000），
 *     所以别想着用 drawbox 画运动物体，要运动就用自带运动的源（testsrc2 实测 4.16）。
 *     反过来，这个"不重新求值"正好适合画**必须静止**的播放器控件条。
 */
const SCENES_SPEC = [
  { kind: 'flat', color: '0x0d0d10' },
  { kind: 'motion', hue: 0, eq: 'brightness=0.20:saturation=1.0' },
  { kind: 'flat', color: '0xe8e8ea' },
  { kind: 'motion', hue: 210, eq: 'brightness=-0.30:saturation=1.1' },
  { kind: 'flat', color: '0x8a1010' },
  { kind: 'motion', hue: 120, eq: 'brightness=0.10:saturation=1.2' },
];

/** 一个场景的 lavfi 滤镜图。 */
function sceneFilter(spec) {
  if (spec.kind === 'flat') {
    return [
      `color=c=${spec.color}:s=${W}x${H}:r=${FPS}:d=${SCENE_SECONDS}`,
      `drawgrid=w=40:h=40:t=2:c=0xffffff@0.18`,
      `noise=alls=7:allf=p`,
    ].join(',');
  }
  return [
    `testsrc2=s=${W}x${H}:r=${FPS}:d=${SCENE_SECONDS}`,
    `hue=h=${spec.hue}`,
    `eq=${spec.eq}`,
  ].join(',');
}

/**
 * 假播放器控件条：深色底 + 一条进度条 + 两个按钮形状。
 * 关键是**每一帧都一模一样**，所以逐行时序统计会把它判成"静止且暗"的条带。
 */
function barFilter() {
  return [
    `color=c=0x0a0a0a:s=${W}x${BAR}:r=${FPS}:d=${SCENE_SECONDS * SCENES}`,
    `drawbox=x=48:y=11:w=200:h=6:color=0x9a9a9a:t=fill`,
    `drawbox=x=${W - 160}:y=9:w=60:h=10:color=0x555555:t=fill`,
    `drawbox=x=${W - 80}:y=9:w=24:h=10:color=0x555555:t=fill`,
  ].join(',');
}

async function main() {
  const out = path.resolve(flag('out', path.join('demo', 'demo.mp4')));
  if (exists(out) && !argv.includes('--force')) {
    console.log(`已经存在，跳过：${out}（要覆盖请加 --force）`);
    return 0;
  }
  ensureDir(path.dirname(out));

  const { path: ffmpeg, source } = resolveFfmpeg();
  console.log(`ffmpeg : ${ffmpeg}  (来源：${source})`);
  const ver = await ffmpegVersion(ffmpeg);
  console.log(`版本   : ${ver.version || ver.line || '未知'}`);

  const inputs = [];
  for (let i = 0; i < SCENES; i++) inputs.push('-f', 'lavfi', '-i', sceneFilter(SCENES_SPEC[i]));
  inputs.push('-f', 'lavfi', '-i', barFilter());

  // 先把 6 个场景顺序拼起来，再把控件条竖着叠到下面。
  const filter =
    `[0:v][1:v][2:v][3:v][4:v][5:v]concat=n=${SCENES}:v=1:a=0[body];` +
    `[body][${SCENES}:v]vstack=inputs=2[out]`;

  const args = [
    '-hide_banner', '-nostdin', '-y',
    ...inputs,
    '-filter_complex', filter,
    '-map', '[out]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-t', String(SCENE_SECONDS * SCENES),
    '-movflags', '+faststart',
    out,
  ];

  console.log(`\n开始生成 ${SCENES * SCENE_SECONDS}s / ${W}x${H + BAR} / ${FPS}fps 的合成演示视频 …`);
  const t0 = Date.now();
  const r = await runFfmpeg(ffmpeg, args, { timeoutMs: 5 * 60 * 1000 });
  if (r.code !== 0) {
    console.error(`ffmpeg 失败（exit ${r.code}）：\n${r.stderr.split(/\r?\n/).slice(-12).join('\n')}`);
    return 1;
  }

  console.log(`\n完成：${out}`);
  console.log(`大小：${humanBytes(fileSize(out))}　用时：${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`\n下一步可以跑：`);
  console.log(`  node bin/shotkit.mjs run "${out}" --out demo/out --filmstrip`);
  console.log(`预期：探到 ${SCENES} 个镜头，并自动裁掉底部约 ${BAR}px 的控件条（${W}x${H}+0+0）。`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
