/**
 * Sub-dividing a single shot into model-sized windows.
 *
 * Why this exists: every mainstream character-replacement tool is a
 * single-call, *single-shot* model with a hard window — 81 frames at 16 fps
 * (≈5.06 s) for the Wan/VACE family, 3–15 s for Kling 3.0, 5–15 s for Viggle,
 * 3–30 s for Runway Act-Two. Nothing consumes a 60-second edit in one go, and
 * the models that do support long clips implement it internally as
 * "previous segment's tail → next segment's head" (Wan Animate's
 * `continue_motion` / `video_frame_offset` / `trim_image`, DreamActor-M1's
 * last-latent hand-off). So cutting the shot into overlapping windows is not an
 * optimisation, it is a precondition.
 *
 * The layout produced here is deliberately simple and even:
 *   - `n` windows, each of them as long as the window allows;
 *   - the first starts at 0, the last ends exactly at the shot end;
 *   - consecutive windows overlap by at least `overlap` seconds.
 * Even lengths (rather than "max + a short leftover") matter downstream: the
 * models get a consistent amount of motion to track, and the stitched result
 * does not have one weak, very short window at the end of every shot.
 */

/**
 * @param {number} duration  shot length in seconds
 * @param {object} o
 * @param {number} o.maxSegmentSec  longest window a tool accepts
 * @param {number} [o.minSegmentSec]  shortest window worth emitting
 * @param {number} [o.overlapSec]  minimum overlap between neighbours
 * @returns {{segments: object[], count: number, reason: string, evenLength: number}}
 */
export function planSegments(duration, { maxSegmentSec = 15, minSegmentSec = 3, overlapSec = 1 } = {}) {
  const maxSeg = Math.max(0.5, maxSegmentSec);
  const minSeg = Math.max(0, Math.min(minSegmentSec, maxSeg));
  const overlap = Math.max(0, Math.min(overlapSec, maxSeg * 0.5));

  if (!(duration > 0)) return { segments: [], count: 0, reason: '空镜头', evenLength: 0 };

  if (duration <= maxSeg) {
    return {
      segments: [{ index: 1, start: 0, end: duration, duration, offsetStart: 0 }],
      count: 1,
      evenLength: duration,
      reason: '镜头时长在模型单次窗口内，无需再切。',
    };
  }

  const span = maxSeg - overlap;
  const n = Math.max(2, Math.ceil((duration - overlap) / span));
  // Even distribution: every window is exactly `maxSeg` long, the first anchored
  // at 0 and the last anchored at `duration`. Step <= span is guaranteed by the
  // choice of n, so neighbours always overlap by at least `overlap`.
  const step = n > 1 ? (duration - maxSeg) / (n - 1) : 0;

  const segments = [];
  for (let i = 0; i < n; i++) {
    let start = i * step;
    let end = Math.min(duration, start + maxSeg);
    if (i === n - 1) {
      start = Math.max(0, duration - maxSeg);
      end = duration;
    }
    const segDuration = end - start;
    segments.push({
      index: i + 1,
      start: round6(start),
      end: round6(end),
      duration: round6(segDuration),
      offsetStart: round6(start),
      overlapWithPrev: i === 0 ? 0 : round6(segments[i - 1].end - start),
      tooShort: segDuration + 1e-6 < minSeg,
    });
  }

  return {
    segments,
    count: n,
    evenLength: round6(maxSeg),
    reason: `镜头 ${duration.toFixed(2)}s 超过单次窗口 ${maxSeg}s，按 ${n} 段均分（每段 ${maxSeg}s，相邻重叠 ${round6(step > 0 ? maxSeg - step : maxSeg)}s ≈ ${(maxSeg - step).toFixed(2)}s）。`,
    overlapActual: round6(step > 0 ? maxSeg - step : 0),
    minSegmentSec: minSeg,
  };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

/** Where the two neighbours should be swapped, i.e. the midpoint of the overlap. */
export function stitchPoint(prev, next) {
  const boundary = (prev.end + next.start) / 2;
  return round6(boundary);
}

/** Human-readable one-liner for a segment list. */
export function describeSegments(plan) {
  if (!plan || !plan.count) return '（无）';
  if (plan.count === 1) return `整段（${plan.segments[0].duration.toFixed(2)}s）`;
  return plan.segments
    .map((s) => `seg${String(s.index).padStart(2, '0')} ${s.start.toFixed(2)}–${s.end.toFixed(2)}s`)
    .join('  ');
}
