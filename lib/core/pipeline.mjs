/**
 * The end-to-end pipeline, split into composable steps so the DSH tools can run
 * exactly one of them (`aivideo_probe`, `aivideo_detect_shots`, ...) without
 * paying for the whole chain.
 */

import path from 'node:path';
import { resolveFfmpeg, resolveFfprobe, ffmpegVersion } from './ffmpeg.mjs';
import { probeMedia, probePlayableArea } from './probe.mjs';
import { sceneScores, detectShots, summarizeShots } from './shots.mjs';
import { analyzeShots } from './analyze.mjs';
import { cutShots, keyframeTimes } from './split.mjs';
import { classifyShots } from './workflow.mjs';
import { ensureDir, nowStamp, slug, writeJson } from './util.mjs';

export function resolveToolchain({ ffmpegPath, ffprobePath } = {}) {
  const ffmpeg = resolveFfmpeg({ ffmpegPath });
  const ffprobe = resolveFfprobe({ ffprobePath, nearFfmpeg: ffmpeg.path });
  return { ffmpeg: ffmpeg.path, ffmpegSource: ffmpeg.source, candidates: ffmpeg.candidates, ffprobe: ffprobe?.path || null };
}

/**
 * Steps 1-3: metadata, playable-area detection, shot boundaries, per-shot
 * metrics. Deliberately stops before writing anything.
 */
export async function analyzeVideo(input, {
  ffmpegPath,
  autoCrop = true,
  autoSides = false,
  cropOverride = null,
  extraBottom = 0,
  sampleFps = 2,
  sceneWidth = 640,
  minShotDuration = 1.5,
  minScore = 0.3,
  hardScore = 0.55,
  minSharpness = 0.08,
  maxShots = 300,
  analyze = true,
  sampleTargetFrames = 1800,
  segmentPreset = 'cloud',
  maxSegmentSec = null,
  overlapSec = null,
  signal,
  onProgress,
} = {}) {
  const tc = resolveToolchain({ ffmpegPath });
  onProgress?.({ phase: 'toolchain', ffmpeg: tc.ffmpeg });

  const media = await probeMedia(tc.ffmpeg, input);
  const duration = media.video.duration || 0;

  onProgress?.({ phase: 'playable-area' });
  const area = await probePlayableArea(tc.ffmpeg, input, {
    info: media,
    sampleFps,
    autoCrop,
    autoSides,
    extraBottom,
    signal,
  });

  const crop = cropOverride || area.suggestedCrop;
  const cropApplied = Boolean(crop) && !(crop.width === media.video.width && crop.height === media.video.height && !crop.x && !crop.y);

  onProgress?.({ phase: 'scene-scan' });
  const series = await sceneScores(tc.ffmpeg, input, { crop: cropApplied ? crop : null, width: sceneWidth, signal });

  onProgress?.({ phase: 'boundaries' });
  const detection = detectShots(series.times, series.scores, {
    minScore, hardScore, minSharpness, minShotDuration, maxShots, duration,
  });

  let analysis = null;
  if (analyze) {
    onProgress?.({ phase: 'shot-metrics' });
    analysis = await analyzeShots(tc.ffmpeg, input, detection.shots, {
      crop: cropApplied ? crop : null,
      targetFrames: sampleTargetFrames,
      sourceFps: media.video.fps || 30,
      signal,
      onProgress,
    });
  }

  const version = await ffmpegVersion(tc.ffmpeg);

  // Grouping happens here, not in the consumers, so that the cut step can reuse
  // the exact same segment plan the report shows.
  const rawShots = analysis ? analysis.shots : detection.shots;
  const shots = classifyShots(rawShots, { segmentPreset, maxSegmentSec, overlapSec });
  const segmentOptions = { segmentPreset, maxSegmentSec, overlapSec };

  return {
    input,
    toolchain: { ...tc, version: version.version, versionLine: version.line },
    media: {
      container: media.format,
      duration,
      sizeBytes: media.sizeBytes ?? null,
      video: media.video,
      audio: media.audio,
      metadata: media.metadata,
    },
    area,
    crop: cropApplied ? crop : null,
    cropRequested: crop || null,
    scene: { stats: series.stats, frames: series.frames },
    detection,
    summary: summarizeShots(detection.shots),
    shots,
    segmentOptions,
    sampling: analysis?.sampling || null,
    generatedAt: new Date().toISOString(),
  };
}

/** Default output folder: `<parent>/<slug>-shotkit-<stamp>/`. */
export function defaultOutputDir(input, { root = null, prefix = 'shotkit' } = {}) {
  const dir = path.dirname(input);
  const name = slug(path.basename(input, path.extname(input)));
  const base = root || dir;
  return path.join(base, `${name}-${prefix}-${nowStamp()}`);
}

/**
 * Steps 4-5: cut the clips and write the character-replacement bundle.
 */
export async function exportShots(analysisResult, {
  outputDir,
  mode = 'reencode',
  quality = 'balanced',
  crf,
  preset,
  fps = null,
  width = null,
  audio = 'copy',
  only = null,
  minVerdict = null,
  cut = true,
  bundle = true,
  prefix = 'shot',
  segment = false,
  segmentPreset = null,
  maxSegmentSec = null,
  minSegmentSec = null,
  overlapSec = null,
  signal,
  onProgress,
} = {}) {
  const input = analysisResult.input;
  const dir = outputDir || defaultOutputDir(input);
  ensureDir(dir);

  let shots = analysisResult.shots;
  if (only && only.length) {
    const wanted = new Set(only.map(Number));
    shots = shots.filter((s) => wanted.has(s.index));
  } else if (minVerdict && analysisResult.shots[0]?.verdict) {
    const order = { excellent: 3, good: 2, fair: 1, poor: 0 };
    const floor = order[minVerdict] ?? 0;
    shots = shots.filter((s) => (order[s.verdict] ?? 0) >= floor);
  }

  const warnings = [];
  let cutResult = { clips: shots.map((s) => ({ ...s, ok: false, file: null })), mode, warnings, outputDir: dir, totalBytes: 0 };

  if (cut) {
    onProgress?.({ phase: 'cut-preflight', shots: shots.length });
    cutResult = await cutShots(analysisResult.toolchain.ffmpeg, input, shots, {
      outputDir: dir,
      mode,
      crop: analysisResult.crop,
      quality,
      crf,
      preset,
      fps,
      width,
      audio,
      prefix,
      segment,
      segmentPreset: segmentPreset || analysisResult.segmentOptions?.segmentPreset || 'cloud',
      maxSegmentSec: maxSegmentSec ?? analysisResult.segmentOptions?.maxSegmentSec ?? null,
      minSegmentSec,
      overlapSec: overlapSec ?? analysisResult.segmentOptions?.overlapSec ?? null,
      signal,
      onProgress,
    });
  }

  const bundleFiles = bundle
    ? await writeBundle(analysisResult, cutResult, { outputDir: dir, dir })
    : { files: [] };

  writeJson(path.join(dir, 'analysis.json'), {
    input,
    generatedAt: analysisResult.generatedAt,
    toolchain: analysisResult.toolchain,
    media: analysisResult.media,
    crop: analysisResult.crop,
    area: {
      playerUi: analysisResult.area?.playerUi ?? null,
      captureHint: analysisResult.area?.captureHint ?? null,
      bands: analysisResult.area?.bands ?? null,
      note: analysisResult.area?.note ?? null,
    },
    scene: analysisResult.scene,
    detectionStats: analysisResult.detection?.stats ?? null,
    summary: analysisResult.summary,
    sampling: analysisResult.sampling,
    shots: analysisResult.shots,
  });

  return {
    outputDir: dir,
    cut: cutResult,
    bundle: bundleFiles,
    shots: cutResult.clips,
    warnings: [...warnings, ...(cutResult.warnings || [])],
    analysisFile: path.join(dir, 'analysis.json'),
  };
}

/** Re-export the pieces tools reach for directly. */
export { keyframeTimes, sceneScores, detectShots, cutShots, probeMedia, probePlayableArea };

// Imported lazily to keep this module free of a hard dependency cycle.
async function writeBundle(...args) {
  const mod = await import('./bundle.mjs');
  return mod.writeBundle(...args);
}
