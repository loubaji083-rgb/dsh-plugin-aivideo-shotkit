/**
 * aivideo-shotkit — low-resolution frame sampling.
 *
 * Frames are decoded by ffmpeg straight into raw `rgb24` and written to a temp
 * FILE (never a pipe): binary on stdout is the one thing that is not portable
 * across PowerShell / cmd / sandboxed spawn, and a file also lets us re-read the
 * same sample many times without paying for another decode.
 */
import fs from 'node:fs';
import { run, runFfmpeg, tmpFile, removeQuietly } from './ffmpeg.mjs';
import { ensureDir } from './util.mjs';

export const BASE_ARGS = ['-hide_banner', '-nostdin', '-y'];

export function buildCropFilter(crop) {
  if (!crop) return null;
  const { width, height, x = 0, y = 0 } = crop;
  if (!width || !height) return null;
  return `crop=${Math.round(width)}:${Math.round(height)}:${Math.round(x)}:${Math.round(y)}`;
}

/**
 * Sample the video at `fps` into a small rgb24 buffer set.
 *
 * @returns {Promise<{width:number,height:number,count:number,fps:number,buffer:Buffer,
 *   frameSize:number, timestamps:number[], crop:object|null}>}
 */
export async function sampleFrames(ffmpeg, input, {
  fps = 4,
  width = 128,
  height = 72,
  start = 0,
  duration = 0,
  crop = null,
  signal,
  timeoutMs = 15 * 60 * 1000,
} = {}) {
  const tmp = tmpFile(null, 'aivideo-sample', 'rgb');
  const filters = [];
  const cropFilter = buildCropFilter(crop);
  if (cropFilter) filters.push(cropFilter);
  filters.push(`fps=${fps}`);
  filters.push(`scale=${width}:${height}:flags=area`);
  filters.push('format=rgb24');

  const args = [...BASE_ARGS, '-loglevel', 'error'];
  const ss = Number(start) || 0;
  if (ss > 0) args.push('-ss', ss.toFixed(6));
  args.push('-i', input);
  if (duration > 0) args.push('-t', Number(duration).toFixed(6));
  args.push(
    '-an', '-sn', '-dn',
    '-vf', filters.join(','),
    '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    tmp,
  );

  try {
    await runFfmpeg(ffmpeg, args, { signal, timeoutMs });
    const buffer = fs.readFileSync(tmp);
    const frameSize = width * height * 3;
    const count = Math.floor(buffer.length / frameSize);
    const timestamps = [];
    for (let i = 0; i < count; i += 1) timestamps.push(ss + i / fps);
    return { width, height, count, fps, buffer, frameSize, timestamps, crop: crop || null };
  } finally {
    await removeQuietly(tmp);
  }
}

/** Slice one frame out of a sample set as a `{r,g,b}`-indexable Uint8Array view. */
export function frameAt(sample, index) {
  const off = index * sample.frameSize;
  return sample.buffer.subarray(off, off + sample.frameSize);
}

/** Luma (Rec.709-ish, integer) of an rgb24 pixel triple. */
export function luma(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0;
}

/**
 * Extract a single frame at `time` seconds as a JPEG/PNG file.
 * `-ss` before `-i` keeps it fast (keyframe seek + decode-forward is accurate
 * enough for 1 frame at these durations, and works on ffmpeg 3.0).
 */
export async function extractFrame(ffmpeg, input, time, outFile, {
  crop = null,
  quality = 2,
  extraFilters = [],
  signal,
} = {}) {
  ensureDir(outFile.replace(/[\\/][^\\/]*$/, ''));
  const filters = [];
  const cropFilter = buildCropFilter(crop);
  if (cropFilter && !extraFilters.includes('nocrop')) filters.push(cropFilter);
  for (const f of extraFilters) if (f !== 'nocrop') filters.push(f);
  const args = [...BASE_ARGS, '-loglevel', 'error', '-ss', Math.max(0, time).toFixed(6), '-i', input, '-frames:v', '1'];
  if (filters.length) args.push('-vf', filters.join(','));
  args.push('-q:v', String(quality), outFile);
  await runFfmpeg(ffmpeg, args, { signal });
  return outFile;
}

/**
 * Build a contact sheet from a list of already-extracted images.
 * Uses ffmpeg's `tile` via the image2 demuxer, which keeps us dependency-free.
 */
export async function buildContactSheet(ffmpeg, files, outFile, { cols = 4, tileWidth = 480 } = {}) {
  if (!files.length) return null;
  const listFile = tmpFile(null, 'aivideo-tile', 'txt');
  const rows = Math.ceil(files.length / cols);
  ensureDir(outFile.replace(/[\\/][^\\/]*$/, ''));
  try {
    const body = files
      .map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(listFile, `${body}\n`, 'utf8');
    const args = [
      ...BASE_ARGS, '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', `scale=${tileWidth}:-1,tile=${cols}x${rows}:padding=4:color=black`,
      '-frames:v', '1', '-q:v', '4', outFile,
    ];
    await runFfmpeg(ffmpeg, args);
    return outFile;
  } catch {
    return null;
  } finally {
    await removeQuietly(listFile);
  }
}

/** Cheap "does the file decode at all" check used before spending time on analysis. */
export async function canDecode(ffmpeg, input) {
  const res = await run(ffmpeg, [...BASE_ARGS, '-loglevel', 'error', '-i', input, '-frames:v', '1', '-f', 'null', '-'], {
    timeoutMs: 60000,
  });
  return res.code === 0;
}
