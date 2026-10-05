/**
 * aivideo-shotkit — small dependency-free helpers.
 *
 * Everything in lib/core is plain ESM Node code with ZERO third-party
 * dependencies, so it runs identically from the CLI (`bin/shotkit.mjs`) and
 * from inside the DSH host plugin (`lib/index.js`).
 */
import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write JSON atomically (tmp + rename) so an interrupted run never leaves a half file. */
export function writeJson(file, value, { pretty = true } = {}) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : 0), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** "00:12.345" — human readable, sortable-ish, used in filenames and reports. */
export function fmtTime(sec, { decimals = 3 } = {}) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  // Pad the integer part, not the rendered float: "0.817".padStart(5) is still
  // "0.817", which is how `01:0.817` used to leak into reports.
  const whole = Math.floor(rest);
  const frac = rest - whole;
  let fracStr = '';
  if (decimals > 0) {
    fracStr = `.${String(Math.round(frac * 10 ** decimals)).padStart(decimals, '0')}`;
    if (fracStr.length > decimals + 1) {
      // Rounding carried (0.9996 -> 1.000): re-render rather than emit "60.000".
      return fmtTime(whole + 1 + (m * 60) + (h * 3600), { decimals });
    }
  }
  const secStr = `${pad(whole)}${fracStr}`;
  return h > 0 ? `${pad(h)}:${pad(m)}:${secStr}` : `${pad(m)}:${secStr}`;
}

/** Filesystem-safe short time token: "01h02m03s456" (never a dot or colon). */
export function fmtTimeToken(sec, { decimals = 3 } = {}) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const whole = Math.floor(rest);
  const frac = Math.round((rest - whole) * 10 ** decimals);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}h${pad(m)}m${pad(whole)}s${pad(frac, decimals)}`;
}

export function humanBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

export function slug(text, { max = 60, fallback = 'video' } = {}) {
  const out = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-\s]+|[.\-\s]+$/g, '');
  const ascii = out.replace(/[^\w.\-\u4e00-\u9fff]+/g, '');
  const final = (ascii || out || '').slice(0, max);
  return final.length >= 2 ? final : fallback;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function mean(arr) {
  if (!arr.length) return 0;
  let t = 0;
  for (const v of arr) t += v;
  return t / arr.length;
}

export function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let t = 0;
  for (const v of arr) t += (v - m) ** 2;
  return Math.sqrt(t / (arr.length - 1));
}

export function median(arr) {
  if (!arr.length) return 0;
  const a = Array.from(arr).sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = Array.from(arr).sort((x, y) => x - y);
  const idx = clamp(Math.round((p / 100) * (a.length - 1)), 0, a.length - 1);
  return a[idx];
}

/** Bucket a numeric range into a stable english+chinese label. */
export function levelLabel(value, thresholds, labels) {
  for (let i = 0; i < thresholds.length; i += 1) {
    if (value <= thresholds[i]) return labels[i];
  }
  return labels[labels.length - 1];
}

export function round(v, digits = 3) {
  const f = 10 ** digits;
  return Math.round((Number(v) || 0) * f) / f;
}

export function nowStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Sleep that rejects cleanly on abort. */
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}
