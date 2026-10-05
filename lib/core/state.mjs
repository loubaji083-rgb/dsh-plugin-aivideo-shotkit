/**
 * A tiny in-memory record of the most recent run, so the browser panel has
 * something to show.
 *
 * Deliberately module-level and process-local: this is a *status light*, not a
 * database. It is never persisted, never written by `bin/shotkit.mjs` (that is a
 * separate process), and losing it on restart costs nothing — the durable
 * artefacts are the files `writeBundle()` puts on disk.
 *
 * Only a *summary* is kept. Pushing whole analyses (thousands of frame metrics)
 * into a global would keep the last video's raw data alive for the whole session.
 */

const state = {
  updatedAt: 0,
  kind: null, // 'analyze' | 'split'
  input: null,
  outputDir: null,
  analysis: null,
  cut: null,
  error: null,
};

function basename(p) {
  return String(p || '').split(/[\\/]/).pop() || String(p || '');
}

function compactAnalysis(result, outputDir) {
  const plan = result.plan || null;
  const shots = Array.isArray(result.shots) ? result.shots : [];
  const groups = {};
  for (const s of shots) {
    const key = s.categoryLabel || s.category || '未分类';
    groups[key] = (groups[key] || 0) + 1;
  }
  return {
    file: basename(result.input),
    input: result.input,
    outputDir: outputDir || result.outputDir || null,
    duration: result.info?.duration ?? null,
    width: result.crop?.width ?? result.info?.video?.width ?? null,
    height: result.crop?.height ?? result.info?.video?.height ?? null,
    crop: result.crop || null,
    playerUi: result.playable?.playerUi ?? false,
    chrome: result.playable?.bands?.chrome || null,
    shotCount: shots.length,
    segmentCount: plan?.segmentCount ?? shots.reduce((n, s) => n + (s.segmentCount || 1), 0),
    recommended: plan?.recommended ?? shots.filter((s) => (s.replaceability ?? 0) >= 0.55).length,
    segmentPreset: plan?.segmentPreset || null,
    segmentPresetLabel: plan?.segmentPresetLabel || null,
    window: plan?.window ?? null,
    overlapSec: plan?.overlapSec ?? null,
    groups,
    top: shots
      .map((s) => ({
        index: s.index,
        start: s.start,
        end: s.end,
        duration: s.duration,
        category: s.categoryLabel || s.category || null,
        verdict: s.verdictLabel || s.verdict || null,
        replaceability: s.replaceability ?? null,
        motionIndex: s.metrics?.motionIndex ?? null,
        motionCoverage: s.metrics?.motionCoverage ?? null,
        motionScope: s.metrics?.motionScope ?? null,
        segmentCount: s.segmentCount || 1,
      }))
      .sort((a, b) => (b.replaceability ?? 0) - (a.replaceability ?? 0))
      .slice(0, 12),
  };
}

export function recordAnalysis(result, { outputDir = null } = {}) {
  state.updatedAt = Date.now();
  state.kind = 'analyze';
  state.input = result?.input || null;
  state.outputDir = outputDir || result?.outputDir || null;
  state.analysis = compactAnalysis(result || {}, outputDir);
  state.error = null;
  return state.analysis;
}

export function recordCut(result, { outputDir = null } = {}) {
  state.updatedAt = Date.now();
  state.kind = 'split';
  state.input = result?.input || state.input;
  state.outputDir = outputDir || result?.outputDir || state.outputDir;
  const clips = Array.isArray(result?.clips) ? result.clips : [];
  state.cut = {
    file: basename(result?.input || state.input),
    outputDir: state.outputDir,
    segmented: !!result?.segmented,
    mode: result?.mode || null,
    total: clips.length,
    ok: clips.filter((c) => c.ok).length,
    failed: clips.filter((c) => !c.ok).length,
    bytes: clips.reduce((n, c) => n + (c.bytes || 0), 0),
  };
  if (result?.analysis && !state.analysis) {
    state.analysis = compactAnalysis(result.analysis, state.outputDir);
  }
  state.error = null;
  return state.cut;
}

export function recordError(message) {
  state.updatedAt = Date.now();
  state.error = String(message || 'unknown');
}

export function snapshot() {
  return { ok: true, host: 'aivideo-shotkit', updatedAt: state.updatedAt, state };
}
