/** Dev smoke test: resolve ffmpeg, probe the file, detect playable area. */
import { resolveFfmpeg, ffmpegVersion } from '../lib/core/ffmpeg.mjs';
import { probeMedia, probePlayableArea } from '../lib/core/probe.mjs';

const input = process.argv[2];
if (!input) {
  console.error('usage: node scripts/smoke-probe.mjs <video>');
  process.exit(2);
}

const { path: ffmpeg, source, candidates } = resolveFfmpeg({});
console.log('ffmpeg   :', ffmpeg, `(${source})`);
console.log('found too:', candidates.slice(1).map((c) => `${c.path} [${c.source}]`).join(' | ') || '(none)');
console.log('version  :', JSON.stringify(await ffmpegVersion(ffmpeg)));

const media = await probeMedia(ffmpeg, input);
console.log('video    :', JSON.stringify(media.video));
console.log('audio    :', JSON.stringify(media.audio));
console.log('duration :', media.duration, 'start:', media.start, 'bitrate:', media.bitrateKbps);
console.log('metadata :', JSON.stringify(media.metadata));

const area = await probePlayableArea(ffmpeg, input, { info: media });
console.log('bands    :', JSON.stringify(area.bands));
console.log('playerUi :', area.playerUi);
console.log('autoCrop :', JSON.stringify(area.autoCrop));
console.log('suggested:', JSON.stringify(area.suggestedCrop));
console.log('note     :', area.note);
