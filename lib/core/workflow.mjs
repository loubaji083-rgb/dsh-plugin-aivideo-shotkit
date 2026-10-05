/**
 * Turn per-shot measurements into a character-replacement work plan.
 *
 * The grouping axis is **motion**, not body framing. Framing would be nicer to
 * report, but nothing on this machine can measure it honestly (no face detector
 * — see `analyze.mjs`), whereas motion is measured directly and is exactly what
 * decides which tool can drive a clip: a still frame can be re-animated, a
 * subtle performance can be re-targeted onto a new face, and a whip-pan has to
 * be shortened before any of it.
 *
 * Shot *scale* (close-up vs full body) is therefore left to visual inspection
 * of the filmstrip, and every label produced here says so.
 */

import { CATEGORIES, SEGMENT_PRESETS, STITCH_GUIDE, TOOL_CATALOG } from './tools-catalog.mjs';
import { planSegments } from './segments.mjs';

export { CATEGORIES, SEGMENT_PRESETS };

/**
 * Motion bands, expressed in **model frames** rather than source frames.
 * `motionIndex` is normalised to a 1/16 s interval (the frame step every
 * Wan/VACE-family model actually consumes) so that a 60 fps screen recording
 * and a 24 fps render land on the same scale.
 *
 * Anchors, from the measured regimes: a static frame sits below 1, a talking
 * head / small gesture sits around 1–4, a walking or fighting figure with a
 * moving camera around 4–12, and a whip-pan or shake above that.
 */
export function regimeOf(motionIndex) {
  if (motionIndex < 1) return 'still';
  if (motionIndex < 4) return 'subtle';
  if (motionIndex < 12) return 'dynamic';
  return 'intense';
}

/** The longest window a category's own guidance allows, clamped by the preset. */
export function windowFor(categoryKey, preset) {
  const def = CATEGORIES[categoryKey];
  const catMax = def?.workflow?.params?.maxClipSeconds ?? 6;
  return Math.min(preset.maxSegmentSec, Math.max(1, catMax));
}

/**
 * @param {object[]} shots  analyzed shots
 * @param {object} [o]
 * @param {string} [o.segmentPreset]  key of SEGMENT_PRESETS
 * @param {number} [o.maxSegmentSec]  explicit override (wins over the preset)
 * @param {number} [o.overlapSec]  explicit override
 */
export function classifyShots(shots, {
  segmentPreset = 'cloud',
  maxSegmentSec = null,
  overlapSec = null,
} = {}) {
  const preset = SEGMENT_PRESETS[segmentPreset] || SEGMENT_PRESETS.cloud;
  return shots.map((shot) => {
    const motion = shot.metrics?.motionIndex ?? 0;
    const key = regimeOf(motion);
    const def = CATEGORIES[key];
    const maxSeg = maxSegmentSec ?? windowFor(key, preset);
    const overlap = overlapSec ?? preset.overlapSec;
    const segmentPlan = planSegments(shot.duration, {
      maxSegmentSec: maxSeg,
      minSegmentSec: preset.minSegmentSec,
      overlapSec: overlap,
    });
    return {
      ...shot,
      category: key,
      categoryLabel: def.label,
      categoryReason: `${def.reason}（运动量 ${motion.toFixed(2)}／模型帧）`,
      segments: segmentPlan,
      workflow: {
        ...def.workflow,
        segmentPreset: preset.id,
        maxSegmentSec: maxSeg,
        overlapSec: overlap,
        subdivide: segmentPlan.count > 1,
        segmentCount: segmentPlan.count,
        recommended: shot.verdict === 'excellent' || shot.verdict === 'good',
      },
    };
  });
}

export function workflowPlan(shots, opts = {}) {
  const preset = SEGMENT_PRESETS[opts.segmentPreset] || SEGMENT_PRESETS.cloud;
  const byKey = new Map();
  for (const s of shots) {
    if (!byKey.has(s.category)) byKey.set(s.category, []);
    byKey.get(s.category).push(s);
  }
  const groups = [...byKey.entries()]
    .map(([key, list]) => ({
      key,
      label: CATEGORIES[key].label,
      workflow: CATEGORIES[key].workflow,
      window: windowFor(key, preset),
      shots: list,
      segmentCount: list.reduce((a, s) => a + (s.segments?.count || 1), 0),
    }))
    .sort((a, b) => order(a.key) - order(b.key));

  const priorityOrder = [...shots]
    .filter((s) => s.replaceability >= 0.55)
    .sort((a, b) => b.replaceability - a.replaceability)
    .slice(0, 12);

  const duration = shots.length ? shots[shots.length - 1].end : 0;
  const segmentCount = shots.reduce((a, s) => a + (s.segments?.count || 1), 0);
  return {
    total: shots.length,
    duration,
    recommended: shots.filter((s) => s.workflow.recommended).length,
    needsShortening: shots.filter((s) => s.workflow.subdivide).length,
    segmentCount,
    segmentPreset: preset.id,
    segmentPresetLabel: preset.label,
    /** Preset-level window; a category may clamp it further (`g.window`). */
    window: preset.maxSegmentSec,
    overlapSec: preset.overlapSec,
    groups,
    priorityOrder,
    tools: TOOL_CATALOG,
    stitch: STITCH_GUIDE,
    note: '分类依据是该镜头的运动量（可测量），不是人物构图；近景/全身请对照 filmstrip 目视确认。',
  };
}

function order(key) {
  return { still: 0, subtle: 1, dynamic: 2, intense: 3 }[key] ?? 9;
}
