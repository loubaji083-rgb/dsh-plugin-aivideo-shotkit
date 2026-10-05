/**
 * aivideo-shotkit — ffmpeg discovery + process plumbing.
 *
 * Deliberately dependency-free and shell-free: every command is spawned with an
 * argument array (never a shell string), so filter graphs containing commas,
 * quotes or semicolons survive Windows and POSIX identically.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exists } from './util.mjs';

/** Known install locations probed after PATH, newest/best build first. */
const WELL_KNOWN = [
  '%LOCALAPPDATA%\\oopz\\ffmpeg.exe',
  '%APPDATA%\\bilibili\\ffmpeg\\ffmpeg.exe',
  '%LOCALAPPDATA%\\Programs\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  '/usr/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/opt/homebrew/bin/ffmpeg',
];

const FFMPEG_NAMES = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg'];
const FFPROBE_NAMES = process.platform === 'win32' ? ['ffprobe.exe', 'ffprobe'] : ['ffprobe'];

function expand(p) {
  return p.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
}

/** Split a PATH-style string for this platform. */
function pathDirs() {
  const raw = process.env.PATH || process.env.Path || '';
  return raw.split(path.delimiter).filter(Boolean);
}

function findByNames(dirs, names) {
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (exists(full)) return full;
    }
  }
  return null;
}

/**
 * Resolve the ffmpeg binary.
 * @returns {{path: string, source: string, candidates: {path: string, source: string}[]}}
 */
export function resolveFfmpeg({ ffmpegPath, extra = [] } = {}) {
  const candidates = [];
  const push = (p, source) => {
    if (!p) return;
    const full = path.resolve(expand(p));
    if (exists(full) && !candidates.some((c) => c.path.toLowerCase() === full.toLowerCase())) {
      candidates.push({ path: full, source });
    }
  };

  push(ffmpegPath, 'config');
  push(process.env.AIVIDEO_FFMPEG, 'env:AIVIDEO_FFMPEG');
  push(process.env.FFMPEG_PATH, 'env:FFMPEG_PATH');
  for (const p of extra) push(p, 'extra');

  const dirs = pathDirs();
  const onPath = findByNames(dirs, FFMPEG_NAMES);
  if (onPath) push(onPath, 'PATH');
  for (const p of WELL_KNOWN) push(p, 'well-known');

  if (!candidates.length) {
    const err = new Error(
      'ffmpeg not found. Install ffmpeg, or set config.ffmpegPath (plugin setting) / the AIVIDEO_FFMPEG environment variable.',
    );
    err.code = 'AIVIDEO_NO_FFMPEG';
    throw err;
  }
  return { path: candidates[0].path, source: candidates[0].source, candidates };
}

/** Resolve ffprobe if the machine has one (ffmpeg builds often ship without it). */
export function resolveFfprobe({ ffprobePath, nearFfmpeg } = {}) {
  const candidates = [];
  const push = (p, source) => {
    if (!p) return;
    const full = path.resolve(expand(p));
    if (exists(full)) candidates.push({ path: full, source });
  };
  push(ffprobePath, 'config');
  push(process.env.AIVIDEO_FFPROBE, 'env');
  const onPath = findByNames(pathDirs(), FFPROBE_NAMES);
  if (onPath) push(onPath, 'PATH');
  if (nearFfmpeg) push(path.join(path.dirname(nearFfmpeg), FFPROBE_NAMES[0]), 'next-to-ffmpeg');
  return candidates.length ? { path: candidates[0].path, source: candidates[0].source } : null;
}

/**
 * Spawn a process and collect its text output.
 * Never throws on a non-zero exit: callers inspect `code` so that a partially
 * successful ffmpeg run (very common) is not mistaken for a crash.
 */
export function run(bin, args, { timeoutMs = 0, maxBuffer = 32 * 1024 * 1024, cwd, signal, onStderr } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      // Restricted sandboxes can synchronously deny spawn (EPERM). Surface it as
      // a normal result instead of an unhandled rejection.
      resolve({
        code: -1,
        signal: null,
        stdout: '',
        stderr: String(err?.message || err),
        ms: 0,
        spawnError: String(err?.code || 'SPAWN_FAILED'),
      });
      return;
    }

    const out = [];
    const errOut = [];
    let outLen = 0;
    let errLen = 0;
    let settled = false;
    let killer = null;

    const finish = (code, sig) => {
      if (settled) return;
      settled = true;
      if (killer) clearTimeout(killer);
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({
        code,
        signal: sig ?? null,
        stdout: out.join(''),
        stderr: errOut.join(''),
        ms: Date.now() - started,
      });
    };

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* ignore */
            }
            finish(-2, 'TIMEOUT');
          }, timeoutMs)
        : null;

    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(-3, 'ABORTED');
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener?.('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (chunk) => {
      if (outLen > maxBuffer) return;
      outLen += chunk.length;
      out.push(chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (onStderr) onStderr(text);
      if (errLen > maxBuffer) return;
      errLen += chunk.length;
      errOut.push(text);
    });
    child.on('error', (err) =>
      resolve({
        code: -1,
        signal: null,
        stdout: out.join(''),
        stderr: `${errOut.join('')}\n${err.message}`,
        ms: Date.now() - started,
        spawnError: String(err?.code || 'SPAWN_ERROR'),
      }),
    );
    child.on('close', (code, sig) => finish(code ?? -1, sig));
  });
}

/** Run ffmpeg and throw on a non-zero exit, with a trimmed stderr tail in the message. */
export async function runFfmpeg(bin, args, opts = {}) {
  const res = await run(bin, args, opts);
  if (res.code !== 0) {
    const tail = res.stderr.split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
    const err = new Error(`ffmpeg exited ${res.code}${res.signal ? ` (${res.signal})` : ''}\n${tail}`);
    err.code = 'AIVIDEO_FFMPEG_FAILED';
    err.ffmpegArgs = args;
    err.ffmpegStderr = res.stderr;
    throw err;
  }
  return res;
}

/** `ffmpeg -version` banner, cached per binary path. */
const versionCache = new Map();
export function ffmpegVersion(bin) {
  if (versionCache.has(bin)) return versionCache.get(bin);
  const p = run(bin, ['-hide_banner', '-version'], { timeoutMs: 15000 });
  return p.then((res) => {
    const line = (res.stdout || res.stderr).split(/\r?\n/)[0] || '';
    const m = /ffmpeg version (\S+)/i.exec(line);
    const info = { line: line.trim(), version: m ? m[1] : null, ok: res.code === 0 };
    versionCache.set(bin, info);
    return info;
  });
}

/** Ask the build whether it knows an encoder (`libx264`, `h264_nvenc`, ...). */
export async function hasEncoder(bin, name) {
  const res = await run(bin, ['-hide_banner', '-encoders'], { timeoutMs: 20000 });
  const text = `${res.stdout}\n${res.stderr}`;
  return new RegExp(`^\\s*[A-Z.]{6}\\s+${name}\\b`, 'm').test(text);
}

export async function hasFilter(bin, name) {
  const res = await run(bin, ['-hide_banner', '-filters'], { timeoutMs: 20000 });
  const text = `${res.stdout}\n${res.stderr}`;
  return new RegExp(`^\\s*[A-Z.]{3}\\s+${name}\\b`, 'm').test(text);
}

export function tmpFile(dir, prefix, ext) {
  const base = dir || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, `${prefix}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

export async function removeQuietly(file) {
  try {
    await fs.promises.rm(file, { force: true });
  } catch {
    /* ignore */
  }
}
