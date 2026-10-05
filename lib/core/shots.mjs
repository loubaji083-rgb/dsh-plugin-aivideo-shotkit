/**
 * Shot (镜头) detection.
 *
 * Strategy: ask ffmpeg for a *complete* per-frame scene-change score series
 * (`select='gte(scene,0)'` plus `metadata=print`), then decide boundaries in
 * JavaScript. Thresholding inside ffmpeg alone is what makes the naive
 * `select='gt(scene,0.25)'` recipe useless on fast AI video: sustained motion
 * keeps producing mid-range scores, so a fixed threshold returns hundreds of
 * "cuts" (263 on the 61 s reference clip).
 *
 * A real cut is an *isolated single-frame spike*: the score jumps at the first
 * frame of the new shot while both neighbours still belong to low-scoring
 * shots. So the acceptance test is not just `score >= threshold` but also
 * `score - max(score[i-1], score[i+1]) >= minSharpness` — the "sharpness" of a
 * peak. Combined with peak clustering and a minimum shot duration this turns
 * the same data into a handful of usable shots.
 */

import { runFfmpeg } from './ffmpeg.mjs';
import { median, percentile, round } from './util.mjs';

const RE_FRAME = /^frame:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*(-?\d+(?:\.\d+)?)/;
const RE_SCORE = /lavfi\.scene_score=\s*(\d+(?:\.\d+)?)/;

/**
 * Decode the whole clip once and capture every frame's scene score.
 *
 * Scores are read from ffmpeg's stdout (`metadata=print:file=-`). Writing to a
 * file instead looks tidier but is a trap on Windows: the filter argument is a
 * filtergraph string, so `C:\Users\<name>\...` loses its backslashes and the
 * `C:` is parsed as an option separator — ffmpeg then fails with
 * `Unable to parse option value "Users<name>..." as boolean`.
 *
 * @returns {Promise<{times:number[],scores:number[],frames:number,fps:number,stats:object}>}
 */
export async function sceneScores(ffmpeg, input, {
  crop = null,
  width = 640,
  timeoutMs = 30 * 60 * 1000,
  signal,
  onProgress,
} = {}) {
  const chains = [];
  if (crop && crop.width && crop.height) {
    chains.push(`crop=${crop.width}:${crop.height}:${crop.x || 0}:${crop.y || 0}`);
  }
  if (width) chains.push(`scale=${width}:-2:flags=bilinear`);
  chains.push("select='gte(scene,0)'");
  chains.push('metadata=print:file=-');

  const res = await runFfmpeg(ffmpeg, [
    '-hide_banner', '-nostdin', '-v', 'error',
    '-i', input,
    '-an', '-sn',
    '-vf', chains.join(','),
    '-f', 'null', '-',
  ], {
    timeoutMs,
    signal,
    maxBuffer: 256 * 1024 * 1024,
    onStderr: onProgress,
  });

  const { times, scores } = parseSceneReport(res.stdout);
  if (!scores.length) {
    throw new Error(
      'ffmpeg produced no scene scores; this build may not support `metadata=print:file=-`. ' +
      `stderr tail: ${(res.stderr || '').trim().split(/\r?\n/).slice(-3).join(' | ')}`,
    );
  }
  return {
    times,
    scores,
    frames: scores.length,
    stats: seriesStats(scores),
  };
}

function parseSceneReport(text) {
  const times = [];
  const scores = [];
  let pendingTime = null;
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const fm = RE_FRAME.exec(line);
    if (fm) {
      pendingTime = Number(fm[3]);
      continue;
    }
    const sm = RE_SCORE.exec(line);
    if (sm) {
      scores.push(Number(sm[1]));
      times.push(pendingTime === null ? times.length : pendingTime);
      pendingTime = null;
    }
  }
  // A seek or a stream-copy remux can leave the first pts negative; shift the
  // series so callers can compare against the container duration directly.
  if (times.length && times[0] < -0.5) {
    const shift = -times[0];
    for (let i = 0; i < times.length; i++) times[i] += shift;
  }
  return { times, scores };
}

function seriesStats(scores) {
  return {
    frames: scores.length,
    max: round(Math.max(...scores), 4),
    mean: round(scores.reduce((a, b) => a + b, 0) / scores.length, 5),
    p50: round(median(scores), 5),
    p90: round(percentile(scores, 90), 4),
    p99: round(percentile(scores, 99), 4),
    p999: round(percentile(scores, 99.9), 4),
  };
}

/**
 * Turn a score series into shot boundaries.
 *
 * @param {number[]} times   absolute frame times in seconds
 * @param {number[]} scores  scene score per frame
 */
export function detectShots(times, scores, {
  minScore = 0.3,
  hardScore = 0.55,
  minSharpness = 0.08,
  clusterWindow = 0.15,
  minShotDuration = 1.5,
  maxShots = 300,
  duration = 0,
} = {}) {
  const n = scores.length;
  if (n < 2) {
    return { boundaries: [], shots: [], candidates: [], stats: { frames: n, candidates: 0, spikes: 0, clusters: 0, kept: 0 } };
  }

  const spikes = [];
  for (let i = 0; i < n; i++) {
    const s = scores[i];
    if (s < minScore) continue;
    const prev = i > 0 ? scores[i - 1] : 0;
    const next = i < n - 1 ? scores[i + 1] : 0;
    const sharp = s - Math.max(prev, next);
    if (s >= hardScore || sharp >= minSharpness) {
      spikes.push({ i, t: times[i], s: scores[i], sharp });
    }
  }

  // A dissolve spans several frames above threshold; collapse neighbours into
  // one boundary, keeping the strongest frame and remembering how wide the
  // ramp was so the caller can label hard cuts vs fades.
  const clusters = [];
  for (const sp of spikes) {
    const last = clusters[clusters.length - 1];
    if (last && sp.t - last.tEnd <= clusterWindow) {
      last.tEnd = sp.t;
      last.frames += 1;
      if (sp.s > last.s) {
        last.s = sp.s;
        last.t = sp.t;
        last.i = sp.i;
        last.sharp = sp.sharp;
      }
    } else {
      clusters.push({ ...sp, tEnd: sp.t, frames: 1 });
    }
  }

  // Enforce a minimum shot duration by dropping the weaker of two boundaries
  // that are too close. A cut every 0.3 s is a glitch, not an edit.
  const kept = [];
  for (const c of clusters) {
    let drop = false;
    while (kept.length && c.t - kept[kept.length - 1].t < minShotDuration) {
      const last = kept[kept.length - 1];
      if (c.s > last.s) kept.pop();
      else { drop = true; break; }
    }
    if (!drop) kept.push(c);
  }

  let selected = kept;
  let truncated = false;
  if (selected.length > maxShots) {
    selected = [...selected].sort((a, b) => b.s - a.s).slice(0, maxShots).sort((a, b) => a.t - b.t);
    truncated = true;
  }

  const end = duration || (times[n - 1] + (times[n - 1] - times[n - 2] || 1 / 60));
  const boundaries = [Number(times[0].toFixed(6) || 0)];
  for (const c of selected) {
    const t = Number(c.t.toFixed(6));
    if (t > boundaries[boundaries.length - 1] + 1e-4 && t < end - 1e-4) boundaries.push(t);
  }
  boundaries.push(Number(end.toFixed(6)));

  // The minimum-duration pass only constrains boundaries *between* kept cuts,
  // so the head and tail of the clip can still end up as a 0.2 s sliver. Fold
  // those into their neighbour instead of emitting an unusable clip.
  const mergedEnds = [];
  if (boundaries.length > 2 && boundaries[1] - boundaries[0] < minShotDuration) {
    mergedEnds.push({ side: 'head', dropped: boundaries[1] });
    boundaries.splice(1, 1);
  }
  if (boundaries.length > 2 && boundaries[boundaries.length - 1] - boundaries[boundaries.length - 2] < minShotDuration) {
    mergedEnds.push({ side: 'tail', dropped: boundaries[boundaries.length - 2] });
    boundaries.splice(boundaries.length - 2, 1);
  }

  const shots = [];
  for (let k = 0; k < boundaries.length - 1; k++) {
    const start = boundaries[k];
    const stopT = boundaries[k + 1];
    const dur = stopT - start;
    const cut = k === 0 ? null : selected.find((c) => Math.abs(c.t - start) < 1e-4) || null;
    shots.push({
      index: k + 1,
      start: Number(start.toFixed(3)),
      end: Number(stopT.toFixed(3)),
      duration: Number(dur.toFixed(3)),
      cutScore: cut ? round(cut.s, 4) : null,
      cutType: !cut ? 'head' : cut.frames >= 3 ? 'dissolve' : 'cut',
      short: dur < minShotDuration,
    });
  }

  return {
    boundaries,
    shots,
    candidates: clusters.map((c) => ({
      t: round(c.t, 3),
      score: round(c.s, 4),
      sharpness: round(c.sharp, 4),
      width: c.frames,
      type: c.frames >= 3 ? 'dissolve' : 'cut',
    })),
    config: { minScore, hardScore, minSharpness, clusterWindow, minShotDuration, maxShots },
    mergedEnds,
    stats: {
      frames: n,
      aboveMinScore: spikes.length,
      clusters: clusters.length,
      kept: selected.length,
      merged: clusters.length - kept.length,
      mergedEnds: mergedEnds.length,
      truncated,
      meanShotDuration: shots.length ? round(shots.reduce((a, s) => a + s.duration, 0) / shots.length, 3) : 0,
    },
  };
}

/** Re-label short shots so downstream code can merge or warn about them. */
export function summarizeShots(shots) {
  const total = shots.reduce((a, s) => a + s.duration, 0);
  const durations = shots.map((s) => s.duration);
  return {
    count: shots.length,
    totalDuration: round(total, 3),
    meanDuration: round(durations.length ? total / durations.length : 0, 3),
    medianDuration: round(median(durations), 3),
    minDuration: round(durations.length ? Math.min(...durations) : 0, 3),
    maxDuration: round(durations.length ? Math.max(...durations) : 0, 3),
    shortShots: shots.filter((s) => s.short).map((s) => s.index),
    dissolveShots: shots.filter((s) => s.cutType === 'dissolve').map((s) => s.index),
  };
}

export { summarizeShots as summarize };
