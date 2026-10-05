/**
 * aivideo-shotkit — media probing + playable-area detection.
 *
 * There is no ffprobe on many Windows boxes (including the bilibili-bundled
 * ffmpeg 3.0 build), so all metadata is parsed out of the `ffmpeg -i` banner,
 * which has been stable since 2013.
 */
import { run } from './ffmpeg.mjs';
import { sampleFrames, luma, frameAt } from './frames.mjs';
import { clamp, round } from './util.mjs';

const RE_DURATION = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
const RE_START = /start:\s*(-?\d+(?:\.\d+)?)/;
const RE_BITRATE = /bitrate:\s*(\d+)\s*kb\/s/;
const RE_STREAM = /^\s*Stream #(\d+):(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?(?:\[[^\]]*\])?:\s*(\w+):\s*(.*)$/;
const RE_FPS = /(\d+(?:\.\d+)?)\s*(?:fps|tbr)/g;
const RE_SAR = /\[SAR (\d+):(\d+) DAR (\d+):(\d+)\]/;
const RE_ROTATE = /rotate\s*:\s*(-?\d+)/;

function hmsToSeconds(h, m, s) {
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/**
 * Split on `sep` only where it is NOT inside (), [] or <>. `ffmpeg -i` puts
 * codec profiles, pixel formats and side data in parentheses that themselves
 * contain commas — `yuv420p(tv, bt709, progressive)` — which a naive split
 * shreds.
 */
function splitTopLevel(text, sep = ',') {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '<') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '>') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur.trim());
  return parts.filter((p) => p.length > 0);
}

/**
 * Pull WxH out of a video stream description. Uses the parsed top-level field
 * that is exactly `WxH ...` — a loose /\d+x\d+/ also matches the codec tag
 * `avc1 / 0x31637661` and yields the nonsense size 0x31637661.
 */
function firstSize(fields, text) {
  for (const f of fields) {
    const m = /^(\d{2,5})x(\d{2,5})\b/.exec(f);
    if (m) return m;
  }
  return /(?:^|[\s,])(\d{2,5})x(\d{2,5})(?:\s|,|$)/.exec(text);
}

/** Parse the stderr banner of `ffmpeg -i <file>`. */
export function parseFfmpegBanner(stderr = '') {
  const out = { video: null, audio: [], duration: null, start: 0, bitrateKbps: null, metadata: {}, rotate: 0, raw: stderr };

  // NOTE: use [ \t] and not \s here — `\s*` spans newlines, which makes
  // `search()` return the index of the *previous* newline and shifts the whole
  // metadata block by one line.
  const metaBlock = /^[ \t]*Metadata:[ \t]*$/m;
  if (metaBlock.test(stderr)) {
    const tail = stderr.slice(stderr.search(metaBlock));
    for (const line of tail.split(/\r?\n/).slice(1, 20)) {
      const trimmed = line.trim();
      if (/^(Duration|Stream|At least|Output|Input)\b/.test(trimmed)) break;
      const m = /^\s{2,}([A-Za-z0-9_.\- ]+?)\s*:\s*(.+?)\s*$/.exec(line);
      if (!m) break;
      out.metadata[m[1].trim()] = m[2].trim();
    }
  }

  const d = RE_DURATION.exec(stderr);
  if (d) out.duration = hmsToSeconds(d[1], d[2], d[3]);
  const st = RE_START.exec(stderr);
  if (st) out.start = Number(st[1]);
  const br = RE_BITRATE.exec(stderr);
  if (br) out.bitrateKbps = Number(br[1]);
  const rot = RE_ROTATE.exec(stderr);
  if (rot) out.rotate = Number(rot[1]);

  const lines = stderr.split(/\r?\n/);
  for (const line of lines) {
    const m = RE_STREAM.exec(line);
    if (!m) continue;
    const [, sIdx, eIdx, lang, kind, rest] = m;
    const index = `${sIdx}:${eIdx}`;
    const fields = splitTopLevel(rest);
    if (kind === 'Video' && !out.video) {
      const size = firstSize(fields, rest);
      const fpsAll = [...rest.matchAll(RE_FPS)].map((x) => Number(x[1])).filter((v) => v > 0 && v < 10000);
      const sar = RE_SAR.exec(rest);
      out.video = {
        index,
        lang: lang || null,
        codec: (fields[0] || '').replace(/^Video:\s*/, '').trim(),
        pixFmt: fields[1] || null,
        width: size ? Number(size[1]) : null,
        height: size ? Number(size[2]) : null,
        fps: fpsAll.length ? Math.max(...fpsAll) : null,
        sar: sar ? `${sar[1]}:${sar[2]}` : null,
        dar: sar ? `${sar[3]}:${sar[4]}` : null,
        line: line.trim(),
        fields,
      };
    } else if (kind === 'Audio') {
      const hz = /(\d+)\s*Hz/.exec(rest);
      out.audio.push({
        index,
        lang: lang || null,
        codec: (fields[0] || '').replace(/^Audio:\s*/, '').trim(),
        sampleRate: hz ? Number(hz[1]) : null,
        channels: fields[2] || null,
        sampleFormat: fields[3] || null,
        line: line.trim(),
        fields,
      });
    }
  }
  out.encoder = out.metadata.encoder || out.metadata['encoder'] || null;
  out.handlerName = out.metadata.handler_name || null;
  return out;
}

export async function probeMedia(ffmpeg, input, { timeoutMs = 60000 } = {}) {
  // No output file: ffmpeg prints the full input banner and then exits non-zero
  // with "At least one output file must be specified". Avoiding a real output
  // keeps probing O(1) instead of decoding the whole movie.
  const res = await run(ffmpeg, ['-hide_banner', '-i', input], { timeoutMs });
  const info = parseFfmpegBanner(res.stderr);
  if (!info.video) {
    const err = new Error(`not a decodable video: ${input}`);
    err.code = 'AIVIDEO_UNREADABLE';
    err.stderr = res.stderr;
    throw err;
  }
  info.path = input;
  // The banner puts the container duration at the top level; every consumer
  // wants it next to the video stream, so mirror it.
  if (info.video && info.video.duration == null) info.video.duration = info.duration ?? null;
  return info;
}

/**
 * Detect non-content bands (letterbox, player chrome, watermarks) by projecting
 * temporal statistics onto rows and columns.
 *
 * A row belongs to a "chrome" band when most of its pixels are either very dark
 * in *every* sampled frame (a solid bar) or unchanged across *every* sampled
 * frame (a static overlay). Real footage fails both tests because something in
 * the row moves or is lit.
 */
export function detectBands(sample, { darkThreshold = 34, staticThreshold = 0.72, darkFrac = 0.5 } = {}) {
  const { width: w, height: h, count: n } = sample;
  if (n < 2) {
    return emptyBands(w, h);
  }

  const rowStatic = new Float64Array(h);
  const rowDark = new Float64Array(h);
  const colStatic = new Float64Array(w);
  const colDark = new Float64Array(w);

  for (let y = 0; y < h; y += 1) {
    let allDark = 0;
    let unchanged = 0;
    for (let x = 0; x < w; x += 1) {
      let min = 255;
      let max = 0;
      let allDarkPixel = 1;
      for (let f = 0; f < n; f += 1) {
        const buf = frameAt(sample, f);
        const o = (y * w + x) * 3;
        const L = luma(buf[o], buf[o + 1], buf[o + 2]);
        if (L < min) min = L;
        if (L > max) max = L;
        if (L >= darkThreshold) allDarkPixel = 0;
      }
      if (allDarkPixel) allDark += 1;
      if (max - min <= 6) unchanged += 1;
    }
    rowStatic[y] = unchanged / w;
    rowDark[y] = allDark / w;
  }

  for (let x = 0; x < w; x += 1) {
    let allDark = 0;
    let unchanged = 0;
    for (let y = 0; y < h; y += 1) {
      let min = 255;
      let max = 0;
      let allDarkPixel = 1;
      for (let f = 0; f < n; f += 1) {
        const buf = frameAt(sample, f);
        const o = (y * w + x) * 3;
        const L = luma(buf[o], buf[o + 1], buf[o + 2]);
        if (L < min) min = L;
        if (L > max) max = L;
        if (L >= darkThreshold) allDarkPixel = 0;
      }
      if (allDarkPixel) allDark += 1;
      if (max - min <= 6) unchanged += 1;
    }
    colStatic[x] = unchanged / h;
    colDark[x] = allDark / h;
  }

  const rowIsChrome = (y) => rowStatic[y] >= staticThreshold || rowDark[y] >= darkFrac;
  const colIsChrome = (x) => colStatic[x] >= staticThreshold || colDark[x] >= darkFrac;

  // Backward scans need a "greater than" bound; `grow` takes the exclusive stop
  // index in the direction of travel.
  const topRun = grow(0, h, +1, rowIsChrome);
  const bottomRun = grow(h - 1, -1, -1, rowIsChrome);
  const leftRun = grow(0, w, +1, colIsChrome);
  const rightRun = grow(w - 1, -1, -1, colIsChrome);

  // One extra row/column absorbs the anti-aliased edge of an overlay: the
  // transition row is neither "video" nor "static", so it must be added back
  // explicitly or a 1px sliver of the progress bar survives the crop.
  const top = topRun ? topRun + 1 : 0;
  const bottom = bottomRun ? bottomRun + 1 : 0;
  const left = leftRun ? leftRun + 1 : 0;
  const right = rightRun ? rightRun + 1 : 0;

  // Pure-black runs are letterbox; static-but-lit runs are overlays / chrome.
  const rowIsBlack = (y) => rowDark[y] >= 0.9;
  const colIsBlack = (x) => colDark[x] >= 0.9;
  const blackTop = grow(0, h, +1, rowIsBlack);
  const blackBottom = grow(h - 1, -1, -1, rowIsBlack);
  const blackLeft = grow(0, w, +1, colIsBlack);
  const blackRight = grow(w - 1, -1, -1, colIsBlack);

  const bands = {
    width: w,
    height: h,
    samples: n,
    chrome: {
      top: Math.min(h, Math.max(top, blackTop)),
      bottom: Math.min(h, Math.max(bottom, blackBottom)),
      left: Math.min(w, Math.max(left, blackLeft)),
      right: Math.min(w, Math.max(right, blackRight)),
    },
    black: { top: blackTop, bottom: blackBottom, left: blackLeft, right: blackRight },
    rows: { static: Array.from(rowStatic), dark: Array.from(rowDark) },
  };
  return bands;
}

function emptyBands(w, h) {
  return {
    width: w,
    height: h,
    samples: 0,
    chrome: { top: 0, bottom: 0, left: 0, right: 0 },
    black: { top: 0, bottom: 0, left: 0, right: 0 },
    rows: { static: [], dark: [] },
  };
}

/**
 * Walk from `start` while `predicate` holds. `stop` is the exclusive bound in
 * the direction of travel (so a backward scan passes -1 and a forward scan
 * passes `limit`). Short runs are rejected so a couple of static pixels cannot
 * trigger a crop.
 */
function grow(start, stop, step, predicate, minRun = 2, maxRun = Number.MAX_SAFE_INTEGER) {
  let n = 0;
  let i = start;
  const inBounds = step > 0 ? () => i < stop : () => i > stop;
  while (n < maxRun && i >= 0 && inBounds() && predicate(i)) {
    n += 1;
    i += step;
  }
  return n >= minRun ? n : 0;
}

/**
 * Turn sampled bands into a pixel crop suggestion on the FULL-RESOLUTION frame.
 * `minFraction` guards against cropping a video just because it opens on black.
 */
export function bandsToCrop(bands, frame, {
  minFraction = 0.025,
  evenAlign = true,
  autoSides = false,
  extraBottom = 0,
  extraTop = 0,
} = {}) {
  const { width: FW, height: FH } = frame;
  const scaleY = FH / bands.height;
  const scaleX = FW / bands.width;

  const top = bands.chrome.top * scaleY + extraTop;
  const bottom = bands.chrome.bottom * scaleY + extraBottom;
  const left = autoSides ? bands.chrome.left * scaleX : 0;
  const right = autoSides ? bands.chrome.right * scaleX : 0;

  const minY = Math.max(2, Math.round(FH * minFraction));
  const minX = Math.max(2, Math.round(FW * minFraction));

  let t = top >= minY ? Math.round(top) : 0;
  let b = bottom >= minY ? Math.round(bottom) : 0;
  let l = left >= minX ? Math.round(left) : 0;
  let r = right >= minX ? Math.round(right) : 0;

  if (t + b > FH * 0.6) {
    t = 0;
    b = 0;
  }
  if (l + r > FW * 0.6) {
    l = 0;
    r = 0;
  }

  let width = FW - l - r;
  let height = FH - t - b;
  let x = l;
  let y = t;
  if (evenAlign) {
    width -= width % 2;
    height -= height % 2;
    x -= x % 2;
    y -= y % 2;
  }
  const changed = width !== FW || height !== FH;
  return {
    crop: { x, y, width, height },
    changed,
    source: changed ? 'auto-band-detection' : 'none',
    fractions: {
      top: round(t / FH, 4),
      bottom: round(b / FH, 4),
      left: round(l / FW, 4),
      right: round(r / FW, 4),
    },
  };
}

/**
 * Full playable-area report: probe the file, sample it, and decide whether the
 * recording carries player chrome (progress bar / danmaku box / browser arrows).
 */
export async function probePlayableArea(ffmpeg, input, {
  info = null,
  sampleFps = 2,
  signal,
  playerUiBottomFraction = 0.075,
  autoCrop = true,
  autoSides = false,
  minFraction = 0.025,
  extraBottom = 0,
} = {}) {
  const media = info || (await probeMedia(ffmpeg, input));
  const { width: FW, height: FH, duration } = media.video ?? {};
  if (!FW || !FH) throw new Error(`no video dimensions for ${input}`);

  const sample = await sampleFrames(ffmpeg, input, {
    fps: sampleFps,
    width: 160,
    height: 90,
    start: 0,
    duration: duration && Number.isFinite(duration) ? duration : 0,
    signal,
  });
  const bands = detectBands(sample);
  const auto = bandsToCrop(bands, { width: FW, height: FH }, { minFraction, autoSides, extraBottom });

  // "Captured from a playable file" hint. An OBS / screen-recorder encoder tag
  // is strong evidence that whatever sits at the bottom edge is player chrome,
  // not authored content.
  const encoderText = `${media.metadata?.encoder || ''} ${media.metadata?.handler_name || ''} ${media.video?.line || ''}`;
  const captureHint = /obs|bandicam|camtasia|fraps|screen|录屏|obs_nvenc/i.test(encoderText);

  const chromeBottomFrac = bands.chrome.bottom / bands.height;
  const chromeTopFrac = bands.chrome.top / bands.height;
  const chromeBottomPx = Math.round(chromeBottomFrac * FH);
  const playerUi =
    (chromeBottomFrac >= minFraction && auto.changed) ||
    (captureHint && chromeBottomFrac >= 0.02);

  const fallbackBottomPx = Math.round(FH * playerUiBottomFraction);
  const suggested = auto.changed
    ? auto.crop
    : playerUi
      ? {
          x: 0,
          y: 0,
          width: FW,
          height: (FH - fallbackBottomPx) - ((FH - fallbackBottomPx) % 2),
        }
      : { x: 0, y: 0, width: FW, height: FH };

  return {
    media,
    sample: { fps: sampleFps, width: sample.width, height: sample.height, frames: sample.count },
    bands: {
      chrome: bands.chrome,
      black: bands.black,
      chromeBottomFraction: round(chromeBottomFrac, 4),
      chromeTopFraction: round(chromeTopFrac, 4),
      chromeBottomPx,
    },
    captureHint,
    playerUi,
    autoCrop: auto,
    suggestedCrop: autoCrop ? suggested : { x: 0, y: 0, width: FW, height: FH },
    suggestedCropApplied: autoCrop,
    note: playerUi
      ? `检测到播放器 UI 覆盖层：底部约 ${chromeBottomPx}px 为静态控件条，默认裁掉以得到干净画面（可用 cropBottom 覆盖）。`
      : '未检测到明显的边框或播放器覆盖层，保持原始画幅。',
  };
}

/** Even-aligned size helper shared by crop callers. */
export function evenCrop(crop, frame) {
  return {
    x: clamp(crop.x, 0, frame.width - 2),
    y: clamp(crop.y, 0, frame.height - 2),
    width: clamp(crop.width - (crop.width % 2), 2, frame.width - crop.x),
    height: clamp(crop.height - (crop.height % 2), 2, frame.height - crop.y),
  };
}
