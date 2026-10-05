/**
 * The deliverable the user actually reads: a folder that says which clip to
 * feed to which model, with what settings, with what prompt — and, for shots
 * that are longer than any model's single-call window, the exact sub-segments
 * to feed instead.
 */

import path from 'node:path';
import { CATEGORIES, SEGMENT_PRESETS, STITCH_GUIDE, TOOL_CATALOG, LICENSE_NOTES } from './tools-catalog.mjs';
import { classifyShots, workflowPlan } from './workflow.mjs';
import { VERDICT_LABEL, MOTION_SCOPE_LABEL } from './analyze.mjs';
import { ensureDir, fmtTime, humanBytes, round, writeJson, writeText } from './util.mjs';

export function writeBundle(analysisResult, cutResult, { outputDir, dir, segmentPreset = null } = {}) {
  const outDir = outputDir || dir;
  ensureDir(outDir);
  // `analyzeVideo` already classifies; re-classifying here is only a fallback
  // for callers that hand over a bare shot list.
  const alreadyClassified = analysisResult.shots?.[0]?.category;
  const opts = {
    segmentPreset: segmentPreset || analysisResult.segmentOptions?.segmentPreset || 'cloud',
    maxSegmentSec: analysisResult.segmentOptions?.maxSegmentSec ?? null,
    overlapSec: analysisResult.segmentOptions?.overlapSec ?? null,
  };
  const classified = alreadyClassified && !segmentPreset
    ? analysisResult.shots
    : classifyShots(analysisResult.shots || [], opts);
  const plan = workflowPlan(classified, opts);

  /** shot index → its cut files, ordered by segment index. */
  const byShot = new Map();
  for (const c of cutResult.clips || []) {
    if (!byShot.has(c.index)) byShot.set(c.index, []);
    byShot.get(c.index).push(c);
  }
  for (const list of byShot.values()) list.sort((a, b) => (a.segIndex || 0) - (b.segIndex || 0));

  const records = classified.map((s) => {
    const cuts = byShot.get(s.index) || [];
    const ok = cuts.filter((c) => c.ok);
    const segs = s.segments?.segments || null;
    return {
      index: s.index,
      start: s.start,
      end: s.end,
      duration: s.duration,
      clip: ok.length === 1 && !cuts[0].segIndex ? ok[0].fileName : null,
      segmentCount: s.segments?.count || 1,
      segmentFiles: ok.map((c) => ({
        seg: c.segIndex,
        file: c.fileName,
        start: c.start,
        end: c.end,
        duration: c.duration,
      })),
      segments: segs
        ? segs.map((seg, i) => ({
            seg: seg.index,
            start: round(s.start + seg.start, 3),
            end: round(s.start + seg.end, 3),
            duration: seg.duration,
            overlapSec: seg.overlapWithPrev || 0,
            stitchPoint: i < segs.length - 1
              ? round(s.start + (seg.end + segs[i + 1].start) / 2, 3)
              : null,
            file: ok.find((c) => c.segIndex === seg.index)?.fileName || null,
          }))
        : null,
      category: s.category,
      categoryLabel: s.categoryLabel,
      categoryReason: s.categoryReason,
      verdict: s.verdict,
      verdictLabel: VERDICT_LABEL[s.verdict] || s.verdict,
      replaceability: s.replaceability,
      flags: s.flags,
      metrics: s.metrics,
      workflow: s.workflow,
      prompt: shotPrompt(s),
    };
  });

  const workflow = {
    source: analysisResult.input,
    generatedAt: analysisResult.generatedAt,
    toolchain: { ffmpeg: analysisResult.toolchain.ffmpeg, version: analysisResult.toolchain.version },
    media: {
      duration: analysisResult.media.duration,
      width: analysisResult.media.video.width,
      height: analysisResult.media.video.height,
      fps: analysisResult.media.video.fps,
      cropped: analysisResult.crop,
    },
    cut: {
      mode: cutResult.mode,
      segmented: Boolean(cutResult.segmented),
      warnings: cutResult.warnings || [],
    },
    segmentPreset: plan.segmentPreset,
    stitch: STITCH_GUIDE,
    toolCatalog: TOOL_CATALOG,
    licenseNotes: LICENSE_NOTES,
    plan,
    shots: records,
  };

  const files = [];
  const wj = path.join(outDir, 'workflow.json');
  writeJson(wj, workflow);
  files.push(wj);

  const wf = path.join(outDir, 'prompts.csv');
  writeText(wf, promptsCsv(records));
  files.push(wf);

  const rm = path.join(outDir, 'README.md');
  writeText(rm, bundleReadme(analysisResult, cutResult, workflow));
  files.push(rm);

  return { files, workflow };
}

function shotPrompt(shot) {
  const m = shot.metrics || {};
  const bits = [shot.workflow.prompt];
  bits.push(
    `本镜头时长 ${shot.duration.toFixed(2)} 秒，运动量 ${(m.motionIndex ?? 0).toFixed(2)}（${m.motionLevel || '未知'}，单位＝每个模型帧 1/16s 的平均亮度差），` +
    `亮度 ${m.brightness ?? '-'}，清晰度 ${m.sharpness ?? '-'}。`,
  );
  if (m.motionCoverage != null) {
    const pct = (m.motionCoverage * 100).toFixed(0);
    bits.push(
      m.motionCoverage >= 0.75
        ? `运动覆盖了约 ${pct}% 的画面格子 → 属于整幅运动（摇镜/大幅位移），背景也在动，重构难度高。`
        : `运动集中在约 ${pct}% 的画面格子里 → 属于局部运动（主体在相对静止的环境里动），背景更容易保持。`,
    );
  }
  if (shot.workflow.subdivide) {
    const n = shot.segments?.count || shot.workflow.segmentCount || 2;
    bits.push(
      `镜头时长超过模型单次窗口，已切成 ${n} 个子片段（每段 ≤ ${shot.workflow.maxSegmentSec}s，重叠 ${shot.workflow.overlapSec}s）。` +
      '请逐段送入模型，再按重叠中点拼接。',
    );
  }
  // Not a detection: a warm-lit room makes every surface read as skin, so this
  // is passed through as a hint with its own caveat attached.
  bits.push(`参考：画面暖色像素占比约 ${((m.skinRatio ?? 0) * 100).toFixed(1)}%（启发式，不含人脸检测；镜头尺度请对照 filmstrip 目视确认）。`);
  if (shot.flags?.includes('dissolve-in')) bits.push('该镜头起始处是叠化过渡，建议把起始点后移 3–5 帧，避免把过渡帧喂给模型。');
  if (shot.flags?.includes('exposure-flicker')) bits.push('原片存在曝光闪烁，替换前建议先做一次去闪（deflicker）以免模型把闪烁学进结果。');
  if (shot.flags?.includes('soft-image')) bits.push('原片较软/有运动模糊，替换时适当降低运动强度，避免结果糊成一团。');
  return bits.join('\n');
}

function promptsCsv(shots) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [[
    '镜头', '子段', '片段文件', '起', '止', '时长', '类别', '判定', '可替换性', '建议工具', '提示词',
  ].map(esc).join(',')];
  for (const s of shots) {
    const units = s.segmentFiles?.length
      ? s.segmentFiles
      : [{ seg: null, file: s.clip, start: s.start, end: s.end, duration: s.duration }];
    for (const u of units) {
      rows.push([
        s.index,
        u.seg ?? '',
        u.file || '',
        fmtTime(u.start),
        fmtTime(u.end),
        Number(u.duration).toFixed(2),
        s.categoryLabel,
        s.verdictLabel,
        s.replaceability,
        (s.workflow.tools || []).join(' / '),
        s.prompt,
      ].map(esc).join(','));
    }
  }
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

function bundleReadme(analysisResult, cutResult, workflow) {
  const { media, crop, area, summary, scene } = analysisResult;
  const plan = workflow.plan;
  const preset = SEGMENT_PRESETS[plan.segmentPreset] || SEGMENT_PRESETS.cloud;
  const L = [];
  L.push(`# 人物替换工作流包`);
  L.push('');
  L.push(`- 源文件：\`${analysisResult.input}\``);
  L.push(`- 生成时间：${analysisResult.generatedAt}`);
  L.push(`- 规格：${media.video.width}×${media.video.height} · ${media.video.fps}fps · ${fmtTime(media.duration)} · ${media.video.codec}`);
  if (crop) {
    L.push(`- 已自动裁切：${crop.width}×${crop.height}+${crop.x}+${crop.y}（原始 ${media.video.width}×${media.video.height}）`);
    L.push(`  - 原因：${area?.note || '检测到非画面条带'}`);
  } else {
    L.push('- 未裁切：保留原始画幅');
  }
  L.push(`- 切割方式：${cutResult.mode === 'copy' ? '无损（-c copy，切点吸附关键帧）' : '精确重编码（libx264）'}`);
  L.push(`- 分段窗口：**${preset.label}** — 单段 ≤ ${preset.maxSegmentSec}s，最短 ${preset.minSegmentSec}s，重叠 ${preset.overlapSec}s`);
  L.push('');
  L.push(`## 分镜总览`);
  L.push('');
  L.push(`共切出 **${workflow.shots.length}** 个镜头 / **${plan.segmentCount}** 个可投喂片段，` +
    `平均镜头 ${summary.meanDuration}s，中位 ${summary.medianDuration}s；` +
    `其中 **${plan.recommended}** 个判定为可直接用于替换，**${plan.needsShortening}** 个镜头因超长被二次切分。`);
  L.push('');
  L.push(`> ${plan.note}`);
  L.push('');
  L.push(`场景检测：解析 ${scene.frames} 帧，场景分 p50=${scene.stats.p50} / p90=${scene.stats.p90} / p99=${scene.stats.p99}。`);
  L.push('');

  L.push(`## 为什么要先切镜头`);
  L.push('');
  L.push('主流人物替换模型都是**单次调用、单镜头**的工具，且窗口很窄：');
  L.push('');
  L.push('| 工具 | 单次上限 | 出处 |');
  L.push('|------|----------|------|');
  L.push('| Wan Animate 2（API） | 参考视频 2–30 秒 | alibabacloud.com/model-studio/wan-animate-move-api |');
  L.push('| Wan Animate 2（ComfyUI 节点） | `length=81` 帧 @16fps ≈ 5.06s | docs.comfy.org/built-in-nodes/WanAnimate2ToVideo |');
  L.push('| VACE / Wan2.1 | 81 帧 @16fps ≈ 5.06s | github.com/ali-vilab/VACE |');
  L.push('| Kling 3.0 系 | 3–15 秒（仅 3.0 系支持 multi-shot） | kling.ai document-api capability-map |');
  L.push('| Viggle | 驱动视频 5–15 秒 | docs.viggle.ai/v1/pricing |');
  L.push('| Runway Act-Two | 3–30 秒 @24fps | help.runwayml.com Performance-Capture-with-Act-Two |');
  L.push('');
  L.push('而且长片在这些框架里本来就是「上一段尾帧喂给下一段」实现的（Wan Animate 的 `continue_motion` / `video_frame_offset` / `trim_image`，');
  L.push('DreamActor-M1 用上一段的 last latent 初始化下一段）。所以「先切、再逐段换、再带重叠拼回去」不是优化项，而是这些模型的使用前提。');
  L.push('');

  L.push(`## 一、按工作流分组`);
  L.push('');
  for (const g of plan.groups) {
    L.push(`### ${g.label} — ${g.shots.length} 个镜头 / ${g.segmentCount} 个片段`);
    L.push('');
    L.push(`${g.workflow.summary}`);
    L.push('');
    L.push(`- 推荐工具：${(g.workflow.tools || []).map((t) => toolName(t)).join('、')}`);
    L.push(`- 本类窗口：单段 ≤ ${g.window}s（取「预设上限」与「该类自身建议」的较小值）`);
    const p = g.workflow.params || {};
    if (Object.keys(p).length) {
      L.push(`- 建议参数：${Object.entries(p).map(([k, v]) => `\`${k}=${v}\``).join('，')}`);
    }
    L.push(`- 基础提示词：${g.workflow.prompt}`);
    for (const n of asNotes(g.workflow.notes)) L.push(`- 注意：${n}`);
    L.push('');
    L.push(`涉及镜头：${g.shots.map((s) => `#${s.index}（${s.duration.toFixed(1)}s，${s.verdict}${s.segments?.count > 1 ? `，切 ${s.segments.count} 段` : ''}）`).join('、')}`);
    L.push('');
  }

  L.push(`## 二、逐镜头清单`);
  L.push('');
  L.push('| # | 片段 | 起止 | 时长 | 分段 | 分组 | 运动分布 | 判定 | 可替换性 | 运动量 | 运动覆盖 | 暖色占比* |');
  L.push('|---|------|------|------|------|------|----------|------|----------|--------|----------|-----------|');
  for (const s of workflow.shots) {
    const m = s.metrics || {};
    const clipCell = s.clip
      ? `\`${s.clip}\``
      : (s.segmentFiles?.length ? `${s.segmentFiles.length} 段` : '—');
    L.push(
      `| ${s.index} | ${clipCell} | ${fmtTime(s.start)} → ${fmtTime(s.end)} | ${s.duration.toFixed(2)}s | ` +
      `${s.segmentCount > 1 ? `${s.segmentCount} 段` : '整段'} | ${s.categoryLabel} | ${MOTION_SCOPE_LABEL[m.motionScope] || '—'} | ${s.verdictLabel} | ${s.replaceability} | ` +
      `${(m.motionIndex ?? 0).toFixed(2)} | ${((m.motionCoverage ?? 0) * 100).toFixed(0)}% | ${((m.skinRatio ?? 0) * 100).toFixed(1)}% |`,
    );
  }
  L.push('');
  L.push('\\* 运动覆盖＝画面中有明显运动的区域占比：越小越说明**只有主体在动、背景干净**（好替换），越大越说明整幅都在动（摇镜，难替换）。');
  L.push('暖色占比是画面统计启发式，暖光环境下会严重高估，只可用于镜头之间的相对比较。');
  L.push('**两列都不是人脸检测，也推不出镜头尺度**——近景/全身请对照 `filmstrip.jpg` 目视确认，再决定走换脸还是整身替换。');
  L.push('');

  const segmented = workflow.shots.filter((s) => s.segments && s.segments.length > 1);
  if (segmented.length) {
    L.push(`## 三、超长镜头的子分段（可直接投喂）`);
    L.push('');
    L.push(`以下 ${segmented.length} 个镜头超过模型单次窗口，已按 **每段 ≤ ${preset.maxSegmentSec}s、重叠 ${preset.overlapSec}s** 均分。`);
    L.push('均分而不是「塞满再留个尾巴」：每段长度一致，模型每次拿到的动作量相同，拼接处也不会出现一个特别短的弱段。');
    L.push('');
    L.push('| 镜头 | 段 | 文件 | 全局起止 | 时长 | 与前段重叠 | 建议拼接点 |');
    L.push('|------|----|------|----------|------|------------|------------|');
    for (const s of segmented) {
      for (const seg of s.segments) {
        L.push(
          `| #${s.index} | ${seg.seg}/${s.segments.length} | ${seg.file ? `\`${seg.file}\`` : '—'} | ` +
          `${fmtTime(seg.start)} → ${fmtTime(seg.end)} | ${seg.duration.toFixed(2)}s | ` +
          `${seg.overlapSec ? `${seg.overlapSec.toFixed(2)}s` : '—'} | ${seg.stitchPoint != null ? fmtTime(seg.stitchPoint) : '—'} |`,
        );
      }
    }
    L.push('');
  }

  L.push(`## 四、拼回整片（${segmented.length ? '逐段替换之后' : '替换之后'}）`);
  L.push('');
  L.push(`1. **先统一格式再拼**：${STITCH_GUIDE.normaliseWhy}`);
  L.push(`   \`\`\`bash`);
  L.push(`   ffmpeg -i seg.mp4 -vf "fps=16,scale=832:480:flags=lanczos" -pix_fmt yuv420p -c:v libx264 -crf 18 seg_norm.mp4`);
  L.push(`   \`\`\``);
  L.push(`2. **在重叠中点切换**，不要用端点：${STITCH_GUIDE.stitchPointWhy}`);
  L.push(`3. **接缝做短叠化**：xfade 的 duration 默认 ${STITCH_GUIDE.xfadeSeconds}s（范围 0–60s），offset 必须显式给：`);
  L.push('   ```bash');
  L.push('   ffmpeg -i a.mp4 -i b.mp4 -filter_complex "xfade=transition=fade:duration=1:offset=<a时长-1>" out.mp4');
  L.push('   ```');
  L.push(`4. **别忘了音轨**：${STITCH_GUIDE.concatAudioWhy}`);
  L.push('   ```bash');
  L.push('   ffmpeg -f concat -safe 0 -i list.txt -c copy -movflags +faststart final.mp4');
  L.push('   ```');
  L.push(`5. 想让后续还能用无损粗切：转中间格式时把关键帧钉在切点上 —— \`-force_key_frames ${STITCH_GUIDE.keyframePinning}\`。`);
  L.push('');

  if (plan.priorityOrder.length) {
    L.push(`## 五、建议处理顺序`);
    L.push('');
    L.push('按「可替换性」从高到低处理，先用最好的镜头跑通一遍流程再批量做：');
    L.push('');
    for (const [i, s] of plan.priorityOrder.entries()) {
      L.push(`${i + 1}. 镜头 #${s.index} — ${s.categoryLabel}（可替换性 ${s.replaceability}）`);
    }
    L.push('');
  }

  L.push(`## 六、逐镜头提示词`);
  L.push('');
  for (const s of workflow.shots) {
    L.push(`### 镜头 #${s.index} · ${s.categoryLabel} · ${s.clip || (s.segmentFiles?.length ? `${s.segmentFiles.length} 个子片段` : '（未导出片段）')}`);
    L.push('');
    L.push('```text');
    L.push(s.prompt);
    L.push('```');
    if (s.flags?.length) L.push(`标记：${s.flags.join(', ')}`);
    L.push('');
  }

  L.push(`## 七、许可红线（交付前必看）`);
  L.push('');
  for (const n of LICENSE_NOTES) L.push(`- ${n}`);
  L.push('');

  L.push(`## 八、文件说明`);
  L.push('');
  L.push('- `workflow.json` — 完整机读方案（分镜、分段、指标、分组、提示词、拼接参数）');
  L.push('- `prompts.csv` — **逐片段**提示词表（长镜头已按子段展开），可直接导入表格工具');
  L.push('- `analysis.json` — 原始分析数据（含每个镜头的全部指标）');
  L.push('- `clips.json` — 切割清单与文件校验信息');
  L.push('- `README.md` — 本文件');
  L.push('');
  L.push('> 指标说明：`可替换性` 与 `判定` 由画面统计量（运动量、运动覆盖、闪烁、清晰度、时长、暖色占比）启发式计算，');
  L.push('> 用于排序和筛选，**不等于人脸检测结果**。请以实际试跑效果为准。');
  L.push('');

  if (cutResult.warnings?.length) {
    L.push(`## 切割提示`);
    L.push('');
    for (const w of cutResult.warnings) L.push(`- ${w}`);
    L.push('');
  }
  void round;
  void humanBytes;
  return L.join('\n');
}

/** `notes` is a string in some categories and an array in others; a bare
 *  string would be iterated character by character. */
function asNotes(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function toolName(id) {
  const t = TOOL_CATALOG.find((x) => x.id === id);
  return t ? t.name : id;
}

void CATEGORIES;
