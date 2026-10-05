/** Dev diagnostic: dump per-row / per-column temporal statistics for a video. */
import { resolveFfmpeg } from '../lib/core/ffmpeg.mjs';
import { sampleFrames, frameAt, luma } from '../lib/core/frames.mjs';
import { probeMedia } from '../lib/core/probe.mjs';

const input = process.argv[2];
const W = Number(process.argv[3] || 160);
const H = Number(process.argv[4] || 90);
const { path: ffmpeg } = resolveFfmpeg({});
const media = await probeMedia(ffmpeg, input);
const sample = await sampleFrames(ffmpeg, input, { fps: 2, width: W, height: H, duration: media.duration });
console.log(`frames=${sample.count} grid=${W}x${H} framePx=${media.video.height / H}`);

const rowMean = new Float64Array(H);
const rowStd = new Float64Array(H);
const rowDark = new Float64Array(H);
const rowFrozen = new Float64Array(H);
const rowGradMag = new Float64Array(H);

for (let y = 0; y < H; y += 1) {
  let mn = 0;
  let sd = 0;
  let dk = 0;
  let fr = 0;
  for (let x = 0; x < W; x += 1) {
    let sum = 0;
    let min = 255;
    let max = 0;
    let allDark = 1;
    for (let f = 0; f < sample.count; f += 1) {
      const b = frameAt(sample, f);
      const o = (y * W + x) * 3;
      const L = luma(b[o], b[o + 1], b[o + 2]);
      sum += L;
      if (L < min) min = L;
      if (L > max) max = L;
      if (L >= 34) allDark = 0;
    }
    const m = sum / sample.count;
    mn += m;
    sd += max - min;
    dk += allDark;
    fr += max - min <= 6 ? 1 : 0;
  }
  rowMean[y] = mn / W;
  rowStd[y] = sd / W;
  rowDark[y] = dk / W;
  rowFrozen[y] = fr / W;
}

for (let y = 0; y < H; y += 1) {
  let g = 0;
  for (let f = 0; f < sample.count; f += 1) {
    let s = 0;
    const b = frameAt(sample, f);
    for (let x = 0; x < W; x += 1) {
      const cur = luma(b[(y * W + x) * 3], b[(y * W + x) * 3 + 1], b[(y * W + x) * 3 + 2]);
      const up = luma(b[((y - 1) * W + x) * 3], b[((y - 1) * W + x) * 3 + 1], b[((y - 1) * W + x) * 3 + 2]);
      s += Math.abs(cur - up);
    }
    g += s / W;
  }
  rowGradMag[y] = g / sample.count;
}

console.log('row  frameY   mean   range   dark%  frozen%  grad');
for (let y = 0; y < H; y += 1) {
  const frameY = Math.round((y + 0.5) * (media.video.height / H));
  const mark = y > H * 0.7 ? ' <<' : '';
  console.log(
    String(y).padStart(3),
    String(frameY).padStart(6),
    rowMean[y].toFixed(1).padStart(6),
    rowStd[y].toFixed(1).padStart(6),
    (rowDark[y] * 100).toFixed(0).padStart(6),
    (rowFrozen[y] * 100).toFixed(0).padStart(7),
    rowGradMag[y].toFixed(1).padStart(6),
    mark,
  );
}
