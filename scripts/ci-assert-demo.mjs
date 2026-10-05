/**
 * CI 断言：跑完 `bin/shotkit.mjs run demo/demo.mp4` 之后，检查结果是不是我们期望的那份。
 *
 * 这份断言是 CI 的核心价值所在。合成素材的每一个数字都是确定的（6 个 3 秒场景、
 * 底部 28px 静态控件条），所以任何一处回归都会在这里变成一条失败，而不是
 * "看起来还行"。真实素材没法进仓库，但它能验证的东西，合成素材全都能验证。
 *
 * 用法：
 *   node bin/shotkit.mjs run demo/demo.mp4 --out demo/out --filmstrip
 *   node scripts/ci-assert-demo.mjs [--out demo/out]
 */

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = path.resolve(ROOT, outIdx >= 0 ? argv[outIdx + 1] : 'demo/out');

let pass = 0;
const failures = [];

function check(label, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? `  ← ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? `  ← ${detail}` : ''}`);
  }
}

function near(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'));
}

async function sizeOf(p) {
  try {
    return (await stat(p)).size;
  } catch {
    return -1;
  }
}

console.log(`输出目录：${OUT}\n`);

// ── 文件齐不齐 ────────────────────────────────────────────────────────────
console.log('# 产物存在性');
const analysisPath = path.join(OUT, 'analysis.json');
const workflowPath = path.join(OUT, 'workflow.json');
const promptsPath = path.join(OUT, 'prompts.csv');
const readmePath = path.join(OUT, 'README.md');
const filmstripPath = path.join(OUT, 'filmstrip.jpg');

for (const [name, p] of [
  ['analysis.json', analysisPath],
  ['workflow.json', workflowPath],
  ['prompts.csv', promptsPath],
  ['README.md', readmePath],
  ['filmstrip.jpg', filmstripPath],
]) {
  check(`${name} 存在且非空`, existsSync(p) && (await sizeOf(p)) > 0);
}

const analysis = await readJson(analysisPath);
const workflow = await readJson(workflowPath);

// ── 探测 ──────────────────────────────────────────────────────────────────
console.log('\n# 探测与自动裁切');
check('读到了分辨率 640x388', analysis.media?.video?.width === 640 && analysis.media?.video?.height === 388,
  `实际 ${analysis.media?.video?.width}x${analysis.media?.video?.height}`);
check('时长约 18 秒', near(analysis.media?.duration ?? 0, 18, 0.2), `实际 ${analysis.media?.duration}`);
check('识别出播放器 UI 覆盖层', analysis.area?.playerUi === true);
check('建议裁切高度约 358（真实内容 360，允许 ±1 网格行 = ±4px）',
  near(analysis.crop?.height ?? 0, 358, 4), `实际 ${analysis.crop?.height}`);
check('裁切宽度保持 640', analysis.crop?.width === 640, `实际 ${analysis.crop?.width}`);

// ── 分镜 ──────────────────────────────────────────────────────────────────
console.log('\n# 分镜');
const shots = analysis.shots ?? [];
check('切出 6 个镜头', shots.length === 6, `实际 ${shots.length}`);
check('scene 最高分接近 1（说明硬切被识别到）', (analysis.scene?.stats?.max ?? 0) > 0.8,
  `实际 ${analysis.scene?.stats?.max}`);
check('没有出现"低于阈值一个都没检出"的退化', (analysis.detectionStats?.aboveMinScore ?? 0) > 0,
  `aboveMinScore=${analysis.detectionStats?.aboveMinScore}`);

const expectedCuts = [0, 3, 6, 9, 12, 15, 18];
if (shots.length === 6) {
  for (let i = 0; i < 6; i++) {
    const s = shots[i];
    check(`镜头 #${i + 1} 起点 ${expectedCuts[i]}s（±0.2s）`, near(s.start, expectedCuts[i], 0.2), `实际 ${s.start}`);
    check(`镜头 #${i + 1} 时长 3s（±0.2s）`, near(s.duration, 3, 0.2), `实际 ${s.duration}`);
  }
  // flat 场景逐帧静止 → 运动量应当接近 0；testsrc2 场景自带运动 → 应当明显大于 0
  const flatIdx = [0, 2, 4];
  const motionIdx = [1, 3, 5];
  for (const i of flatIdx) {
    check(`镜头 #${i + 1}（静态色块）运动量 < 0.2`,
      (shots[i].metrics?.motionIndex ?? 99) < 0.2, `实际 ${shots[i].metrics?.motionIndex}`);
  }
  for (const i of motionIdx) {
    check(`镜头 #${i + 1}（带运动测试图）运动量 > 1`,
      (shots[i].metrics?.motionIndex ?? 0) > 1, `实际 ${shots[i].metrics?.motionIndex}`);
  }
}

// ── 分组与分段 ────────────────────────────────────────────────────────────
console.log('\n# 分组与子分段');
check('每个镜头都被分了组', shots.every((s) => typeof s.category === 'string' && s.category.length > 0));
check('每个镜头都有分段计划', shots.every((s) => s.segments && typeof s.segments.count === 'number'));
check('3 秒镜头不需要子分段（每个镜头 1 段）', shots.every((s) => s.segments?.count === 1),
  shots.map((s) => s.segments?.count).join(','));

// ── 切割 ──────────────────────────────────────────────────────────────────
console.log('\n# 切割产物');
const clipsJsonPath = path.join(OUT, 'clips.json');
check('clips.json 存在', existsSync(clipsJsonPath));
const clips = existsSync(clipsJsonPath) ? await readJson(clipsJsonPath) : { clips: [] };
const clipList = clips.clips ?? [];
check('切出 6 个片段', clipList.length === 6, `实际 ${clipList.length}`);
check('全部成功', clipList.every((c) => c.ok === true),
  clipList.filter((c) => !c.ok).map((c) => `${c.shot}:${c.error || 'ok=false'}`).join('; '));
check('切点无漂移（重编码模式应当 drift=0）', clipList.every((c) => !c.drift),
  clipList.map((c) => `#${c.shot}:${c.drift}`).join(' '));

for (const c of clipList) {
  const p = path.join(OUT, c.fileName);
  const bytes = await sizeOf(p);
  check(`片段文件 ${c.fileName} 存在且非空`, bytes > 0, `bytes=${bytes}`);
}

// ── 工作流包 ──────────────────────────────────────────────────────────────
console.log('\n# 工作流包');
check('workflow.json 带 6 条镜头记录', (workflow.shots ?? []).length === 6, `实际 ${(workflow.shots ?? []).length}`);
check('带工具目录', Array.isArray(workflow.toolCatalog) && workflow.toolCatalog.length > 0);
check('带许可提示', Array.isArray(workflow.licenseNotes) && workflow.licenseNotes.length > 0);
check('带拼接指引', !!workflow.stitch && typeof workflow.stitch === 'object');
check('每条记录都带提示词', (workflow.shots ?? []).every((s) => typeof s.prompt === 'string' && s.prompt.length > 10));

const csv = await readFile(promptsPath, 'utf8');
// 注意：提示词里含换行，所以 CSV 是带引号的多行字段，不能靠数行数来断言。
const csvHeader = csv.split(/\r?\n/)[0] ?? '';
check('prompts.csv 表头含「镜头」与「提示词」', csvHeader.includes('镜头') && csvHeader.includes('提示词'),
  csvHeader.slice(0, 80));
const missingInCsv = clipList.filter((c) => !csv.includes(c.fileName));
check('prompts.csv 覆盖全部片段', missingInCsv.length === 0,
  missingInCsv.map((c) => c.fileName).join(', '));

const bundleReadme = await readFile(readmePath, 'utf8');
check('工作流 README 说明裁切原因', /裁切|裁掉|crop/i.test(bundleReadme));
check('工作流 README 含逐镜头清单', /镜头/.test(bundleReadme));

// ── 收尾 ──────────────────────────────────────────────────────────────────
console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项。`);
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\n✅ CI 断言全部通过');
