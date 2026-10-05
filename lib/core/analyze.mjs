/**
 * Per-shot analysis: what is actually inside each shot, and how suitable is it
 * for character replacement?
 *
 * There is no face detector here on purpose. The machine this runs on has no
 * cv2 / onnxruntime / torch and the plugin ships no model weights, so "is there
 * a person, and how big" cannot be answered honestly by this code.
 *
 * What *is* measured honestly:
 *   - temporal statistics (motion, flicker, freeze) — real measurements, and
 *     they decide which replacement tool can drive the clip;
 *   - image statistics (brightness, contrast, sharpness, saturation);
 *   - `warm*` — a YCbCr+RGB skin-tone mask. It is reported because it is
 *     occasionally useful for *ranking* shots against each other, but it is a
 *     colour heuristic: a room lit in saturated warm red makes walls, bedding
 *     and lamps all read as "skin", which is exactly what happened on the first
 *     test clip (20 shots, 13 of them wrongly called person-free).
 *
 * Consumers must present `warm*` as a hint and never let it decide whether a
 * clip is usable. Shot *scale* (close-up vs full body) is left to the filmstrip
 * and a human/vision model looking at it.
 */

import { sampleFrames, frameAt } from './frames.mjs';
import { clamp, mean, median, round, std } from './util.mjs';

const GRID_W = 32;
const GRID_H = 18;

/**
 * The interval every Wan/VACE-family model actually consumes: 81 frames at
 * 16 fps. Motion is reported per *this* interval rather than per source frame,
 * so a 60 fps screen recording and a 24 fps render become comparable, and the
 * numbers line up with the tool windows in `tools-catalog.mjs`.
 */
export const MODEL_FPS = 16;

let gridCache = { key: '', gx: null, gy: null };

/** Precomputed pixel→cell maps, so the per-pixel loop needs no divisions. */
function gridLookups(width, height) {
  const key = `${width}x${height}`;
  if (gridCache.key !== key) {
    const gx = new Int16Array(width);
    for (let x = 0; x < width; x++) gx[x] = Math.min(GRID_W - 1, Math.floor((x / width) * GRID_W));
    const gy = new Int16Array(height);
    for (let y = 0; y < height; y++) gy[y] = Math.min(GRID_H - 1, Math.floor((y / height) * GRID_H));
    gridCache = { key, gx, gy };
  }
  return gridCache;
}

/** Pick a global sampling rate so one decode covers the whole clip. */
export function planSampling(duration, { targetFrames = 1800, maxFps = 30, minFps = 2 } = {}) {
  const fps = clamp(targetFrames / Math.max(duration, 0.5), minFps, maxFps);
  return { fps: Number(fps.toFixed(3)), frames: Math.round(fps * duration) };
}

/**
 * Sample the whole clip once at a low resolution and fold the frames into
 * per-shot statistics.
 *
 * @param {object} o
 * @param {number} o.sourceFps source frame rate, used to report motion in
 *   per-source-frame units (see `finalizeShot`).
 */
export async function analyzeShots(ffmpeg, input, shots, {
  crop = null,
  signal,
  targetFrames = 1800,
  maxFps = 30,
  sourceFps = 30,
  width = 160,
  height = 90,
  onProgress,
} = {}) {
  const duration = shots.length ? shots[shots.length - 1].end : 0;
  const sampling = planSampling(duration, { targetFrames, maxFps, minFps: 2 });
  onProgress?.({ phase: 'sample', fps: sampling.fps, frames: sampling.frames });

  const sample = await sampleFrames(ffmpeg, input, {
    fps: sampling.fps,
    width,
    height,
    start: 0,
    duration: 0,
    crop,
    signal,
  });

  const states = shots.map(() => newState());
  let shotCursor = 0;

  for (let i = 0; i < sample.count; i++) {
    const t = sample.timestamps[i];
    while (shotCursor < shots.length - 1 && t >= shots[shotCursor].end) shotCursor += 1;
    while (shotCursor > 0 && t < shots[shotCursor].start) shotCursor -= 1;
    const inShot = t >= shots[shotCursor].start - 1e-6 && t < shots[shotCursor].end + 1e-6;
    if (!inShot) continue;

    const rgb = frameAt(sample, i);
    const st = states[shotCursor];
    accumulate(st, rgb, new Float32Array(width * height), width, height);
  }

  const analyzed = shots.map((shot, i) =>
    finalizeShot(shot, states[i], { sampling, duration, sourceFps }));

  return {
    shots: analyzed,
    sampling: { ...sampling, sourceFps, width, height },
    sample: { width, height, frames: sample.count, fps: sample.fps },
    duration,
  };
}

function newState() {
  return {
    frames: 0,
    sumLuma: 0,
    sumLumaSq: 0,
    sumGrad: 0,
    sumSat: 0,
    sumSkin: 0,
    sumCenterSkin: 0,
    centerPixels: 0,
    motion: [],
    flicker: [],
    skinGrid: new Float32Array(GRID_W * GRID_H),
    // Row-major |Δluma| accumulated per cell, divided at the end by the number
    // of motion pairs and the pixels each cell holds. This is what separates a
    // whip-pan (everything moves together) from a figure moving inside a steady
    // frame — the second, independent axis the motion magnitude alone cannot give.
    activityGrid: new Float32Array(GRID_W * GRID_H),
    pixelGrid: null,
    activityPairs: 0,
    prevLuma: null,
    prevMeanLuma: null,
    timestamps: [],
  };
}

function accumulate(st, rgb, outLuma, width, height) {
  const n = width * height;
  let sum = 0;
  let sumSq = 0;
  let grad = 0;
  let sat = 0;
  let skin = 0;
  let centerSkin = 0;
  let centerPixels = 0;

  const cx0 = Math.floor(width * 0.3);
  const cx1 = Math.ceil(width * 0.7);
  const cy0 = Math.floor(height * 0.2);
  const cy1 = Math.ceil(height * 0.8);

  const { gx: GX, gy: GY } = gridLookups(width, height);
  const firstFrame = st.frames === 0;
  if (firstFrame) st.pixelGrid = new Float32Array(GRID_W * GRID_H);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 3;
      const r = rgb[p];
      const g = rgb[p + 1];
      const b = rgb[p + 2];
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      outLuma[y * width + x] = L;
      sum += L;
      sumSq += L * L;
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      sat += mx - mn;
      if (x > 0) grad += Math.abs(L - outLuma[y * width + x - 1]);
      if (y > 0) grad += Math.abs(L - outLuma[(y - 1) * width + x]);
      if (firstFrame) st.pixelGrid[GY[y] * GRID_W + GX[x]] += 1;

      if (isSkin(r, g, b)) {
        skin += 1;
        st.skinGrid[GY[y] * GRID_W + GX[x]] += 1;
        if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) centerSkin += 1;
      }
      if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) centerPixels += 1;
    }
  }

  const meanLuma = sum / n;
  st.frames += 1;
  st.sumLuma += meanLuma;
  st.sumLumaSq += sumSq / n;
  st.sumGrad += grad / n;
  st.sumSat += sat / n;
  st.sumSkin += skin / n;
  st.sumCenterSkin += centerSkin / Math.max(1, centerPixels);
  st.centerPixels += centerPixels;

  if (st.prevLuma) {
    let d = 0;
    for (let k = 0; k < n; k++) {
      const dv = Math.abs(outLuma[k] - st.prevLuma[k]);
      d += dv;
      const y = (k / width) | 0;
      st.activityGrid[GY[y] * GRID_W + GX[k - y * width]] += dv;
    }
    st.motion.push(d / n);
    st.activityPairs += 1;
  }
  if (st.prevMeanLuma !== null) st.flicker.push(Math.abs(meanLuma - st.prevMeanLuma));
  st.prevLuma = outLuma;
  st.prevMeanLuma = meanLuma;
  st.timestamps.push(st.frames);
}

/**
 * Rule-based skin classifier: YCbCr (BT.601 full range) intersected with the
 * classic RGB rule, then tightened for *coloured lighting*.
 *
 * The RGB+YCbCr pair alone is what makes the first version report "89 % of the
 * frame is a person" on a room lit in saturated red: any warm mid-bright pixel
 * satisfies it. Skin reflects green and blue far more than a red or magenta
 * light source does, so `g >= 0.55r` and `b >= 0.45r` kill the ambience while
 * leaving normal skin tones (typically g/r ≈ 0.72, b/r ≈ 0.65) intact.
 *
 * Conservative on purpose: a low reading means "no evidence", never "no person".
 */
function isSkin(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx < 70 || mx - mn < 12) return false;
  if (!(r > g && r > b)) return false;
  if (r - g < 10) return false;
  if (g < 0.55 * r) return false;
  if (b < 0.45 * r) return false;
  if ((mx - mn) / mx > 0.6) return false;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  if (cb < 70 || cb > 130 || cr < 130 || cr > 180) return false;
  return true;
}

function finalizeShot(shot, st, { sampling, duration, sourceFps = 30 }) {
  const frames = Math.max(1, st.frames);
  const brightness = st.sumLuma / frames;
  const variance = Math.max(0, st.sumLumaSq / frames - brightness * brightness);
  const contrast = Math.sqrt(variance);
  const gradient = st.sumGrad / frames;
  const saturation = st.sumSat / frames;
  const skinRatio = st.sumSkin / frames;
  const centerSkinRatio = st.sumCenterSkin / frames;

  const motionRaw = st.motion.length ? mean(st.motion) : 0;
  const motionStd = st.motion.length ? std(st.motion) : 0;
  const flicker = st.flicker.length ? mean(st.flicker) : 0;
  const freezeRatio = st.motion.length ? st.motion.filter((d) => d < 0.35).length / st.motion.length : 1;
  // `motionRaw` is the delta across one *sample* interval (1/sampling.fps), so at
  // 12 fps it silently measures 1.3 model frames at once and the number means
  // something different on every run. Rescale to one MODEL_FPS interval (1/16 s)
  // — the frame step the replacement models actually consume — so the value, the
  // category thresholds and the tool windows are all in the same unit.
  const motionIndex = motionRaw * (sampling.fps / MODEL_FPS);

  // How *localised* the motion is. A whip-pan lights up every cell equally; a
  // figure moving inside a steadier frame lights up a minority of them. This is
  // the second axis: same magnitude, very different replacement difficulty.
  const cellRate = new Float32Array(GRID_W * GRID_H);
  if (st.activityPairs > 0 && st.pixelGrid) {
    for (let c = 0; c < cellRate.length; c++) {
      const px = st.pixelGrid[c];
      if (px > 0) cellRate[c] = st.activityGrid[c] / (st.activityPairs * px);
    }
  }
  const activeThr = motionRaw * 1.5;
  let activeCells = 0;
  let peakCell = 0;
  for (let c = 0; c < cellRate.length; c++) {
    const v = cellRate[c];
    if (v > peakCell) peakCell = v;
    if (motionRaw > 0.05 && v > activeThr) activeCells += 1;
  }
  const motionCoverage = motionRaw > 0.05 ? activeCells / cellRate.length : 0;
  const motionConcentration = motionRaw > 0.01 ? round(peakCell / motionRaw, 3) : 0;
  // How *spread out* the motion is: a whip-pan lights up every cell, a figure
  // moving inside a steadier frame lights up a minority. This says how much of
  // the background is being dragged along — which is what decides whether a
  // replacement model has a clean plate to work against. It is deliberately NOT
  // reported as shot scale: measured against the filmstrip this number does not
  // track framing (a close-up of a fast-moving figure and a distant one both
  // land mid-range), so claiming 近景/远景 from it would be a lie.
  const motionScope = motionCoverage >= 0.5 ? 'global' : motionCoverage >= 0.15 ? 'mixed' : 'local';

  const grid = gridStats(st.skinGrid, frames);
  // A skin mask that covers almost every cell is ambient tint, not a person:
  // a room lit in saturated warm red makes walls, bedding and lamps all read as
  // "skin". Detecting that is the whole reason this metric is only a hint.
  const tintSuspected = grid.cellsWithSkin > 0.85 && grid.coverage > 0.5;
  const subjectLikeness = tintSuspected
    ? 0.1
    : clamp(0.5 * clamp(centerSkinRatio / 0.2, 0, 1) + 0.5 * clamp(grid.coverage / 0.16, 0, 1), 0, 1);

  const scores = {
    visibility: subjectLikeness,
    motionFit: motionFit(motionIndex),
    durationFit: durationFit(shot.duration),
    stabilityFit: clamp(1 - (flicker / 9 + freezeRatio * 0.35), 0, 1),
    sharpnessFit: clamp(gradient / 11, 0, 1),
    exposureFit: clamp(1 - flicker / 12, 0, 1),
  };
  // Weights are deliberately lopsided: motion, length and stability are real
  // measurements, while `visibility` is a colour heuristic that a warm-lit room
  // defeats. It is reported and used to *rank* shots, but it must not decide
  // whether a clip is usable.
  const replaceability = clamp(
    0.32 * scores.motionFit +
    0.18 * scores.durationFit +
    0.14 * scores.stabilityFit +
    0.14 * scores.sharpnessFit +
    0.12 * scores.exposureFit +
    0.10 * scores.visibility,
    0,
    1,
  );

  const flags = [];
  if (shot.duration < 1.2) flags.push('too-short');
  if (motionIndex > 12) flags.push('high-motion');
  // Same magnitude, opposite difficulty: a whip-pan drags the whole frame, a
  // moving subject in a steady frame keeps a clean background to reconstruct.
  if (motionIndex > 4 && motionCoverage >= 0.6) flags.push('global-motion');
  if (motionIndex > 4 && motionCoverage > 0 && motionCoverage < 0.15) flags.push('local-motion');
  if (freezeRatio > 0.5) flags.push('freeze-frames');
  if (flicker > 8) flags.push('exposure-flicker');
  if (gradient < 3) flags.push('soft-image');
  if (shot.cutType === 'dissolve') flags.push('dissolve-in');
  if (tintSuspected) flags.push('warm-tint-ambient');
  if (subjectLikeness < 0.12) flags.push('weak-subject-hint');
  if (brightness < 25) flags.push('very-dark');

  return {
    ...shot,
    sampled: st.frames,
    lowSample: st.frames < 3,
    // `warm*` — colour-statistics hints, NOT person detection. See `isSkin`.
    metrics: {
      brightness: round(brightness, 2),
      contrast: round(contrast, 2),
      sharpness: round(gradient, 3),
      saturation: round(saturation, 2),
      skinRatio: round(skinRatio, 4),
      centerSkinRatio: round(centerSkinRatio, 4),
      warmCoverage: round(grid.coverage, 4),
      warmBox: grid.box,
      warmCenterOffset: round(grid.centerOffset, 3),
      warmCells: round(grid.cellsWithSkin, 3),
      tintSuspected,
      motion: round(motionRaw, 3),
      motionIndex: round(motionIndex, 3),
      motionUnit: `mean |Δluma| per 1/${MODEL_FPS}s (model frame)`,
      motionVariability: round(motionStd, 3),
      motionCoverage: round(motionCoverage, 3),
      motionConcentration: motionConcentration,
      motionScope,
      flicker: round(flicker, 3),
      freezeRatio: round(freezeRatio, 3),
      motionLevel: motionLevel(motionIndex),
      brightnessLevel: level(brightness, [45, 95, 190]),
    },
    scores: mapRound(scores, 3),
    replaceability: round(replaceability, 3),
    verdict: verdictOf(replaceability),
    flags,
    sampling: { fps: sampling.fps, frames: st.frames, modelFps: MODEL_FPS, reliable: sampling.fps >= 6 },
    _duration: duration,
  };
}

/** Motion in mean |Δluma| per **model frame** (1/16 s) — see `MODEL_FPS`. */
export function motionLevel(m) {
  if (m < 1) return 'static';
  if (m < 2.5) return 'low';
  if (m < 8) return 'moderate';
  if (m < 18) return 'high';
  return 'extreme';
}

function gridStats(grid, frames) {
  let max = 0;
  let withSkin = 0;
  for (const v of grid) {
    if (v > max) max = v;
    if (v > 0) withSkin += 1;
  }
  const cellsWithSkin = withSkin / (GRID_W * GRID_H);
  let inside = 0;
  let sumW = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = GRID_W;
  let maxX = -1;
  let minY = GRID_H;
  let maxY = -1;
  const thr = max * 0.25;
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const v = grid[y * GRID_W + x];
      if (v <= 0) continue;
      sumW += v;
      sumX += v * (x + 0.5);
      sumY += v * (y + 0.5);
      if (v >= thr && max > 0) {
        inside += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const coverage = inside / (GRID_W * GRID_H);
  const cx = sumW ? sumX / sumW : GRID_W / 2;
  const cy = sumW ? sumY / sumW : GRID_H / 2;
  const dx = (cx - GRID_W / 2) / (GRID_W / 2);
  const dy = (cy - GRID_H / 2) / (GRID_H / 2);
  return {
    coverage: max > 0 ? coverage : 0,
    cellsWithSkin,
    centerOffset: Math.sqrt(dx * dx + dy * dy),
    box: max > 0
      ? {
          x: round(minX / GRID_W, 3),
          y: round(minY / GRID_H, 3),
          width: round((maxX - minX + 1) / GRID_W, 3),
          height: round((maxY - minY + 1) / GRID_H, 3),
        }
      : null,
  };
}

/** Moderate motion is the sweet spot; both a still frame and heavy action lose.
 *  The unit is mean |Δluma| per **model frame** (1/16 s) — see `MODEL_FPS`. */
function motionFit(m) {
  if (m <= 0.6) return 0.35;
  if (m < 2.5) return 0.35 + (0.65 * (m - 0.6)) / 1.9;
  if (m <= 8) return 1;
  if (m <= 18) return 1 - (0.5 * (m - 8)) / 10;
  return clamp(0.5 - (m - 18) * 0.02, 0.15, 0.5);
}

/** Replacement models want a few seconds: enough frames, still one gesture. */
function durationFit(d) {
  if (d < 1.2) return clamp(d / 1.2 * 0.5, 0, 0.5);
  if (d < 2) return 0.5 + (0.5 * (d - 1.2)) / 0.8;
  if (d <= 6) return 1;
  if (d <= 10) return 1 - (0.3 * (d - 6)) / 4;
  return clamp(0.7 - (d - 10) * 0.02, 0.25, 0.7);
}

function level(v, [a, b, c]) {
  if (v < a) return 'very-low';
  if (v < b) return 'low';
  if (v < c) return 'moderate';
  return 'high';
}

/**
 * Verdict is driven by measurable properties (motion, length, exposure), never
 * by the skin heuristic — see `finalizeShot`.
 */
function verdictOf(score) {
  if (score >= 0.72) return 'excellent';
  if (score >= 0.58) return 'good';
  if (score >= 0.42) return 'fair';
  return 'poor';
}

export const VERDICT_LABEL = {
  excellent: '极佳（优先用于人物替换）',
  good: '良好（可直接用于人物替换）',
  fair: '可用（建议微调或缩短时长后使用）',
  poor: '条件不理想（运动过强或画面过暗，建议缩短或先做稳定化）',
};

/**
 * Labels for `metrics.motionScope` — how much of the frame is being dragged
 * along by the motion, i.e. how clean the background stays for a replacement
 * model to work against. This is *not* shot scale; scale has to be read off the
 * filmstrip by eye.
 */
export const MOTION_SCOPE_LABEL = {
  global: '整幅运动（摇镜/大幅位移，背景也在动）',
  mixed: '部分画面运动',
  local: '局部运动（只有主体在动，背景干净）',
};

function mapRound(obj, digits) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = round(v, digits);
  return out;
}

export { median };
