/**
 * Diagnostic: is the inter-frame luma delta real motion, or AI shimmer?
 *
 * Real motion grows ~linearly with the frame gap (the scene keeps changing in
 * the same direction). Uncorrelated shimmer — texture crawl, denoiser wobble,
 * compression breathing — grows like sqrt(gap), because consecutive noise
 * samples are independent. So the ratio between gap g and gap 1 tells us which
 * one dominates the metric.
 *
 * Usage: node scripts/motion-diag.mjs <video> [startSeconds] [seconds]
 */

import { resolveFfmpeg } from '../lib/core/ffmpeg.mjs';
import { sampleFrames, frameAt } from '../lib/core/frames.mjs';
import { mean } from '../lib/core/util.mjs';

const input = process.argv[2];
const start = Number(process.argv[3] || 0);
const seconds = Number(process.argv[4] || 4);
const FPS = 60;
const W = 160;
const H = 90;

const { path: ffmpeg } = resolveFfmpeg({});
const sample = await sampleFrames(ffmpeg, input, { fps: FPS, width: W, height: H, start, duration: seconds });

const lumas = [];
for (let i = 0; i < sample.count; i++) {
  const rgb = frameAt(sample, i);
  const y = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) {
    y[p] = 0.2126 * rgb[p * 3] + 0.7152 * rgb[p * 3 + 1] + 0.0722 * rgb[p * 3 + 2];
  }
  lumas.push(y);
}

function deltaAt(gap) {
  const out = [];
  for (let i = 0; i + gap < lumas.length; i++) {
    let s = 0;
    for (let p = 0; p < W * H; p++) s += Math.abs(lumas[i + gap][p] - lumas[i][p]);
    out.push(s / (W * H));
  }
  return mean(out);
}

console.log(`frames=${sample.count} fps=${FPS} window=${start}s+${seconds}s`);
const base = deltaAt(1);
console.log(`gap 1 (1/60 s): ${base.toFixed(3)}   ratio 1.000`);
for (const gap of [2, 3, 4, 6, 8, 12]) {
  const d = deltaAt(gap);
  console.log(`gap ${String(gap).padStart(2)} (${(gap / FPS).toFixed(3)} s): ${d.toFixed(3)}   ratio ${(d / base).toFixed(3)}  (linear if ≈${gap}, sqrt if ≈${Math.sqrt(gap).toFixed(2)})`);
}

// Per-pixel temporal std separated into "always busy" vs "occasionally busy"
// cells: shimmer lights up every cell a little, real motion lights up few cells
// a lot.
const cellW = 10;
const cellH = 10;
let busy = 0;
let total = 0;
for (let cy = 0; cy < H; cy += cellH) {
  for (let cx = 0; cx < W; cx += cellW) {
    let s = 0;
    let n = 0;
    for (let i = 1; i < lumas.length; i++) {
      for (let y = cy; y < Math.min(cy + cellH, H); y++) {
        for (let x = cx; x < Math.min(cx + cellW, W); x++) {
          s += Math.abs(lumas[i][y * W + x] - lumas[i - 1][y * W + x]);
          n += 1;
        }
      }
    }
    const avg = s / n;
    total += 1;
    if (avg > 1.5 * base) busy += 1;
  }
}
console.log(`\nframe mean |dluma| per 1/60s = ${base.toFixed(3)} (${((base / 255) * 100).toFixed(2)}% of full range)`);
console.log(`cells moving above 1.5x frame mean: ${busy}/${total} (${((busy / total) * 100).toFixed(0)}%)`);
