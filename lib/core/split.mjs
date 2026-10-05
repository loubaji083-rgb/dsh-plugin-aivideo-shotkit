/**
 * Cutting shots out of the source clip.
 *
 * Two modes, because they answer different questions:
 *
 *  - `reencode` (default) — frame-accurate. The cut lands exactly on the
 *    boundary the detector chose, and the auto-crop can be baked in. Costs a
 *    generation of quality and time.
 *  - `copy` — `-c copy`, no re-encode at all. Only possible on keyframes, so
 *    the requested boundaries are snapped to the nearest keyframe (and the crop
 *    must be a no-op). Every clip is then bit-identical to the source and the
 *    shots still tile the whole timeline with no gaps.
 *
 * Keyframe times come from `-skip_frame nokey`, i.e. no ffprobe needed — the
 * ffmpeg builds on this machine ship without it.
 */

import path from 'node:path';
import { BASE_ARGS, buildCropFilter } from './frames.mjs';
import { run, runFfmpeg } from './ffmpeg.mjs';
import { planSegments } from './segments.mjs';
import { SEGMENT_PRESETS } from './tools-catalog.mjs';
import { ensureDir, exists, fileSize, fmtTime, fmtTimeToken, humanBytes, round, writeJson } from './util.mjs';

/** Decode only keyframes and read their timestamps. */
export async function keyframeTimes(ffmpeg, input, { timeoutMs = 10 * 60 * 1000, signal } = {}) {
  const res = await run(ffmpeg, [
    '-hide_banner', '-nostdin', '-v', 'info',
    '-skip_frame', 'nokey',
    '-i', input,
    '-an', '-sn',
    '-vsync', '0',
    '-vf', 'showinfo',
    '-f', 'null', '-',
  ], { timeoutMs, signal });

  const times = [];
  const re = /pts_time:(-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(res.stderr))) {
    const t = Number(m[1]);
    if (t >= 0) times.push(Number(t.toFixed(6)));
  }
  times.sort((a, b) => a - b);
  // De-duplicate: some builds print the same keyframe twice under `-vsync 0`.
  const out = [];
  for (const t of times) if (!out.length || t - out[out.length - 1] > 1e-4) out.push(t);
  return { times: out, count: out.length, stderr: res.stderr };
}

function snapToKeyframe(times, t) {
  if (!times.length) return t;
  let best = times[0];
  let bestD = Math.abs(times[0] - t);
  for (const k of times) {
    const d = Math.abs(k - t);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/**
 * Snap every shot boundary onto the keyframe grid, keeping the timeline
 * tiling: shot i ends exactly where shot i+1 begins.
 */
export function snapShotsToKeyframes(shots, keyframes) {
  if (!keyframes.length) return { shots: shots.map((s) => ({ ...s, snapped: false })), maxDrift: 0 };
  const starts = [];
  for (const s of shots) starts.push(snapToKeyframe(keyframes, s.start));
  // Force monotonicity: a snap may collapse two boundaries onto one keyframe.
  for (let i = 1; i < starts.length; i++) if (starts[i] <= starts[i - 1]) starts[i] = starts[i - 1];
  const lastEnd = Math.max(starts[starts.length - 1] + (1 / 30), snapToKeyframe(keyframes, shots[shots.length - 1].end));
  const bounds = [...starts, lastEnd];

  let maxDrift = 0;
  const out = shots.map((s, i) => {
    const start = bounds[i];
    const end = bounds[i + 1];
    maxDrift = Math.max(maxDrift, Math.abs(start - s.start), Math.abs(end - s.end));
    return {
      ...s,
      originalStart: s.start,
      originalEnd: s.end,
      start: round(start, 6),
      end: round(end, 6),
      duration: round(end - start, 6),
      drift: round(start - s.start, 6),
      snapped: true,
    };
  });
  return { shots: out, maxDrift: round(maxDrift, 3) };
}

export function clipFilename(shot, { prefix = 'shot', ext = 'mp4', pad = 3, seg = null, segPad = 2 } = {}) {
  const idx = String(shot.index).padStart(pad, '0');
  const segTag = seg ? `_seg${String(seg).padStart(segPad, '0')}` : '';
  return `${prefix}_${idx}${segTag}_${fmtTimeToken(shot.start)}-${fmtTimeToken(shot.end)}.${ext}`;
}

/** Quality presets that all three ffmpeg builds on this machine can honour. */
export const QUALITY_PRESETS = {
  high: { crf: 16, preset: 'slow' },
  balanced: { crf: 18, preset: 'medium' },
  fast: { crf: 21, preset: 'veryfast' },
  lossless: { crf: 0, preset: 'medium' },
};

/**
 * @param {object} o
 * @param {'reencode'|'copy'} o.mode
 * @param {boolean} o.segment  emit model-sized sub-windows for long shots
 *   (`shot_013_seg02_….mp4`) instead of one file per shot. Long shots cannot be
 *   handed to any replacement model whole — see `segments.mjs`.
 * @returns {Promise<{clips: object[], mode: string, warnings: string[], outputDir: string}>}
 */
export async function cutShots(ffmpeg, input, shots, {
  outputDir,
  mode = 'reencode',
  crop = null,
  quality = 'balanced',
  crf,
  preset,
  fps = null,
  width = null,
  audio = 'copy',
  audioBitrate = '192k',
  signal,
  onProgress,
  prefix = 'shot',
  ext = 'mp4',
  manifestName = 'clips.json',
  segment = false,
  segmentPreset = 'cloud',
  maxSegmentSec = null,
  minSegmentSec = null,
  overlapSec = null,
} = {}) {
  ensureDir(outputDir);
  const warnings = [];
  const cropFilter = buildCropFilter(crop);

  let effectiveMode = mode;
  if (mode === 'copy' && cropFilter) {
    effectiveMode = 'reencode';
    warnings.push(
      `请求无损切割（-c copy），但需要裁切画面（${cropFilter}），裁切无法在 -c copy 下完成，已自动切换为精确重编码。`,
    );
  }
  if (mode === 'copy' && segment) {
    effectiveMode = 'reencode';
    warnings.push(
      '子分段（--segment）需要帧精确切点，而 -c copy 只能切在关键帧上，已自动切换为精确重编码。',
    );
  }

  let workShots = shots;
  if (effectiveMode === 'copy') {
    const { times, count } = await keyframeTimes(ffmpeg, input, { signal });
    if (!times.length) {
      effectiveMode = 'reencode';
      warnings.push('未能读取关键帧列表，无损切割不可用，已自动切换为精确重编码。');
    } else {
      const snapped = snapShotsToKeyframes(shots, times);
      workShots = snapped.shots;
      if (snapped.maxDrift > 0.5) {
        warnings.push(
          `无损切割已把切点吸附到关键帧，最大偏移 ${snapped.maxDrift.toFixed(3)}s（共 ${count} 个关键帧）。若偏移不可接受请改用精确模式。`,
        );
      }
    }
  }

  const q = QUALITY_PRESETS[quality] || QUALITY_PRESETS.balanced;

  // Flatten shots into cut units. A unit is either a whole shot or one
  // model-sized window inside it.
  const units = [];
  for (const shot of workShots) {
    let segs = shot.segments?.segments;
    let segCount = shot.segments?.count || 1;
    if (segment && (!segs || maxSegmentSec || minSegmentSec || overlapSec)) {
      const preset = SEGMENT_PRESETS[segmentPreset] || SEGMENT_PRESETS.cloud;
      const plan = planSegments(shot.duration, {
        maxSegmentSec: maxSegmentSec ?? shot.workflow?.maxSegmentSec ?? preset.maxSegmentSec,
        minSegmentSec: minSegmentSec ?? preset.minSegmentSec,
        overlapSec: overlapSec ?? shot.workflow?.overlapSec ?? preset.overlapSec,
      });
      segs = plan.segments;
      segCount = plan.count;
    }
    if (!segment || segCount <= 1 || !segs) {
      units.push({ shot, segIndex: null, segCount: 1, start: shot.start, end: shot.end, duration: shot.duration });
      continue;
    }
    for (const s of segs) {
      units.push({
        shot,
        segIndex: s.index,
        segCount,
        start: round(shot.start + s.start, 6),
        end: round(shot.start + s.end, 6),
        duration: round(s.end - s.start, 6),
        overlapSec: s.overlapWithPrev || 0,
      });
    }
  }

  const clips = [];
  const total = units.length;

  for (let i = 0; i < total; i++) {
    const u = units[i];
    const shot = u.shot;
    const file = path.join(outputDir, clipFilename(
      { index: shot.index, start: u.start, end: u.end },
      { prefix, ext, seg: u.segIndex },
    ));
    const args = [...BASE_ARGS, '-loglevel', 'error'];

    if (effectiveMode === 'reencode') {
      args.push('-ss', u.start.toFixed(6), '-i', input, '-t', u.duration.toFixed(6));
    } else {
      args.push('-ss', u.start.toFixed(6), '-i', input, '-t', u.duration.toFixed(6), '-avoid_negative_ts', 'make_zero');
    }
    args.push('-map', '0:v:0', '-map', '0:a?');

    if (effectiveMode === 'reencode') {
      const filters = [];
      if (cropFilter) filters.push(cropFilter);
      if (fps) filters.push(`fps=${fps}`);
      if (width) filters.push(`scale=${width}:-2:flags=lanczos`);
      if (filters.length) args.push('-vf', filters.join(','));
      args.push('-c:v', 'libx264', '-crf', String(crf ?? q.crf), '-preset', preset || q.preset, '-pix_fmt', 'yuv420p');
    } else {
      args.push('-c:v', 'copy');
    }

    if (audio === 'none') args.push('-an');
    else if (audio === 'copy' && effectiveMode === 'copy') args.push('-c:a', 'copy');
    else if (audio === 'copy') args.push('-c:a', 'aac', '-b:a', audioBitrate);
    else args.push('-c:a', 'aac', '-b:a', audioBitrate);

    args.push('-movflags', '+faststart', '-y', file);

    onProgress?.({ phase: 'cut', index: i, total, shot, segIndex: u.segIndex, segCount: u.segCount, file });
    const res = await run(ffmpeg, args, { timeoutMs: 20 * 60 * 1000, signal });
    if (res.code !== 0) {
      const tail = res.stderr.split(/\r?\n/).filter(Boolean).slice(-6).join(' | ');
      const label = u.segIndex ? `镜头 #${shot.index} 第 ${u.segIndex}/${u.segCount} 段` : `镜头 #${shot.index}`;
      warnings.push(`${label} 切割失败（exit ${res.code}）：${tail}`);
      clips.push({ ...u, file: null, ok: false, error: tail, index: shot.index });
      continue;
    }

    clips.push({
      ...u,
      index: shot.index,
      category: shot.category,
      categoryLabel: shot.categoryLabel,
      file,
      fileName: path.basename(file),
      ok: true,
      bytes: exists(file) ? fileSize(file) : 0,
    });
  }

  writeJson(path.join(outputDir, manifestName), {
    source: input,
    mode: effectiveMode,
    requestedMode: mode,
    segmented: Boolean(segment),
    crop: crop || null,
    quality: { name: quality, crf: crf ?? q.crf, preset: preset || q.preset },
    warnings,
    clips: clips.map((c) => ({
      shot: c.index,
      seg: c.segIndex,
      segCount: c.segCount,
      start: c.start,
      end: c.end,
      duration: c.duration,
      fileName: c.fileName || null,
      bytes: c.bytes || 0,
      ok: c.ok,
      drift: c.drift ?? 0,
    })),
  });

  return {
    clips,
    mode: effectiveMode,
    segmented: Boolean(segment),
    warnings,
    outputDir,
    totalBytes: clips.reduce((a, c) => a + (c.bytes || 0), 0),
  };
}

export function describeCutResult(result) {
  const ok = result.clips.filter((c) => c.ok);
  return {
    mode: result.mode,
    segmented: Boolean(result.segmented),
    clips: ok.length,
    failed: result.clips.length - ok.length,
    totalBytes: humanBytes(result.totalBytes),
    warnings: result.warnings,
    files: ok.map((c) => ({
      file: c.fileName,
      shot: c.index,
      seg: c.segIndex,
      from: fmtTime(c.start),
      to: fmtTime(c.end),
      size: humanBytes(c.bytes),
    })),
  };
}
