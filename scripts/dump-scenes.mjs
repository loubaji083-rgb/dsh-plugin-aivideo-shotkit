/**
 * Diagnostic: decode the clip once, dump the full per-frame scene-score series,
 * then run the JavaScript boundary detector against it so thresholds can be
 * tuned without re-decoding.
 *
 *   node scripts/dump-scenes.mjs <video> [--width 640] [--no-crop] [--min 0.3] [--out <dir>]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveFfmpeg } from '../lib/core/ffmpeg.mjs';
import { probeMedia, probePlayableArea } from '../lib/core/probe.mjs';
import { sceneScores, detectShots, summarizeShots } from '../lib/core/shots.mjs';
import { fmtTime } from '../lib/core/util.mjs';

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
if (!input) {
  console.error('usage: node scripts/dump-scenes.mjs <video> [--width 640] [--no-crop] [--min 0.3] [--minShot 1.5]');
  process.exit(2);
}
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};
const noCrop = args.includes('--no-crop');
const width = opt('width', 640);
const outIdx = args.indexOf('--out');

const resolved = resolveFfmpeg();
const ffmpeg = resolved.path;
console.log('ffmpeg   :', ffmpeg, `(${resolved.source})`);

const media = await probeMedia(ffmpeg, input);
const area = await probePlayableArea(ffmpeg, input, { info: media });
const crop = noCrop ? null : area.suggestedCrop;
const durationSec = media.video.duration || 0;
console.log('duration :', durationSec, 'size:', `${media.video.width}x${media.video.height}`, 'fps:', media.video.fps);
console.log('crop     :', JSON.stringify(crop), 'playerUi:', area.playerUi, `bottom=${area.bands.chromeBottomPx}px`);

const t0 = Date.now();
const series = await sceneScores(ffmpeg, input, { crop, width });
console.log(`scored   : ${series.frames} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('stats    :', JSON.stringify(series.stats));

const workDir = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : '.');
mkdirSync(workDir, { recursive: true });
const seriesFile = path.join(workDir, 'scene-series.json');
writeFileSync(seriesFile, JSON.stringify({ input, crop, width, fps: media.video.fps, duration: durationSec, times: series.times, scores: series.scores, stats: series.stats }));
console.log('written  :', seriesFile);

const result = detectShots(series.times, series.scores, {
  minScore: opt('min', 0.3),
  hardScore: opt('hard', 0.55),
  minSharpness: opt('sharp', 0.08),
  minShotDuration: opt('minShot', 1.5),
  duration: durationSec,
});

console.log('\n-- candidates (clustered scene spikes) --');
for (const c of result.candidates.slice(0, 60)) {
  console.log(`  ${fmtTime(c.t)}  score=${c.score.toFixed(3)}  sharp=${c.sharpness.toFixed(3)}  w=${c.width}  ${c.type}`);
}
console.log(`  ... ${result.candidates.length} total`);
console.log('\n-- stats --', JSON.stringify(result.stats));
console.log('\n-- shots --');
for (const s of result.shots) {
  console.log(`  #${String(s.index).padStart(3, '0')}  ${fmtTime(s.start)} -> ${fmtTime(s.end)}  dur=${s.duration.toFixed(3)}s  ${s.cutScore === null ? '' : `cut=${s.cutScore.toFixed(3)}`}  ${s.cutType}${s.short ? ' SHORT' : ''}`);
}
console.log('\nsummary  :', JSON.stringify(summarizeShots(result.shots)));
