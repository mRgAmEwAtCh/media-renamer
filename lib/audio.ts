import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CancelledError, commitNoOverwrite, isCancellation, partialPathFor } from './mover.ts';

/** Codes a track may be tagged with, by language (ISO 639-1 → 639-1/639-2 B/T). */
const LANGUAGE_GROUPS = [
  ['de', 'ger', 'deu'],
  ['en', 'eng'],
  ['fr', 'fre', 'fra'],
  ['es', 'spa'],
  ['it', 'ita'],
  ['nl', 'dut', 'nld'],
  ['pl', 'pol'],
  ['pt', 'por'],
  ['sv', 'swe'],
  ['da', 'dan'],
  ['no', 'nor', 'nob', 'nno'],
  ['fi', 'fin'],
  ['cs', 'cze', 'ces'],
  ['ru', 'rus'],
  ['tr', 'tur'],
  ['ja', 'jpn'],
];
const DOLBY_CODECS = new Set(['ac3', 'eac3', 'truehd']);
const DTS_CODECS = new Set(['dts']);
const MAX_EAC3_CHANNELS = 6; // ffmpeg's E-AC-3 encoder supports up to 5.1
const STEREO_BITRATE = '256k';
const STDERR_TAIL = 4000;

export function languageAliases(code) {
  const normalized = String(code ?? '').trim().toLowerCase();
  return new Set(LANGUAGE_GROUPS.find((group) => group.includes(normalized)) ?? [normalized]);
}

const channelLabel = (channels) => (channels >= 6 ? '5.1' : channels === 2 ? '2.0' : channels === 1 ? '1.0' : `${channels}ch`);

/**
 * Decide which DTS tracks need a Dolby Digital Plus companion. For each wanted
 * language: a Dolby track (AC3, E-AC-3, TrueHD) means nothing to do; otherwise
 * the first DTS track in that language is converted. Untagged tracks are ignored.
 */
export function planAudioFix(probe, { languages }) {
  const audio = (probe?.streams ?? []).filter((stream) => stream.codec_type === 'audio');
  const conversions = [];
  const notes = [];
  for (const language of languages) {
    const aliases = languageAliases(language);
    const inLanguage = audio.filter((stream) => aliases.has(String(stream.tags?.language ?? '').toLowerCase()));
    if (inLanguage.some((stream) => DOLBY_CODECS.has(stream.codec_name))) {
      notes.push(`${language}: already has a Dolby track`);
      continue;
    }
    const dts = inLanguage.find((stream) => DTS_CODECS.has(stream.codec_name));
    if (!dts) {
      notes.push(`${language}: no DTS track`);
      continue;
    }
    const channels = Number(dts.channels) || 6;
    conversions.push({
      streamIndex: dts.index,
      language: dts.tags.language,
      channels,
      outputChannels: Math.min(channels, MAX_EAC3_CHANNELS),
      source: dts.profile || 'DTS',
    });
  }
  return {
    action: conversions.length ? 'convert' : 'skip',
    reason: conversions.length ? null : notes.join('; ') || 'no audio tracks',
    conversions,
    audioCount: audio.length,
    duration: Number(probe?.format?.duration) || null,
  };
}

/** ffmpeg arguments: copy every original stream unchanged, append one E-AC-3 track per conversion. */
export function buildFfmpegArgs({ input, output, plan, bitrate = '1024k' }) {
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-i', input, '-map', '0'];
  for (const conversion of plan.conversions) args.push('-map', `0:${conversion.streamIndex}`);
  args.push('-c', 'copy');
  plan.conversions.forEach((conversion, offset) => {
    const n = plan.audioCount + offset;
    args.push(`-c:a:${n}`, 'eac3', `-b:a:${n}`, conversion.outputChannels <= 2 ? STEREO_BITRATE : bitrate);
    if (conversion.channels > conversion.outputChannels) args.push(`-ac:a:${n}`, String(conversion.outputChannels));
    args.push(
      `-metadata:s:a:${n}`,
      `language=${conversion.language}`,
      `-metadata:s:a:${n}`,
      `title=Dolby Digital Plus ${channelLabel(conversion.outputChannels)} (converted from ${conversion.source})`,
      `-disposition:a:${n}`,
      '0',
    );
  });
  args.push('-max_muxing_queue_size', '4096', '-progress', 'pipe:1', '-nostats', '-f', 'matroska', output);
  return args;
}

/** Seconds of output written so far, from one line of `-progress` output. */
export function parseProgressLine(line) {
  const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
  return match ? Number(match[1]) / 1e6 : null;
}

function run(command, args, { signal, onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let buffered = '';
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (!onLine) {
        stdout += text;
        return;
      }
      buffered += text;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      lines.forEach((line) => onLine(line.trim()));
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL);
    });
    child.on('error', (error) => {
      signal?.removeEventListener('abort', abort);
      reject(error.code === 'ENOENT' ? new Error(`${command} is not installed`) : error);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(new CancelledError());
      if (code === 0) return resolve(stdout);
      reject(new Error(`${path.basename(command)} failed: ${stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${code}`}`));
    });
  });
}

export async function probeFile(file, { ffprobe = 'ffprobe', signal } = {}) {
  const output = await run(
    ffprobe,
    ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,profile,channels:stream_tags=language,title:format=duration', '-of', 'json', file],
    { signal },
  );
  return JSON.parse(output);
}

const availability = new Map();

/** Whether ffmpeg and ffprobe can be run (cached). */
export async function audioToolsAvailable({ ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' } = {}) {
  const key = `${ffmpeg}\0${ffprobe}`;
  if (!availability.has(key)) {
    availability.set(
      key,
      Promise.all([run(ffmpeg, ['-hide_banner', '-version']), run(ffprobe, ['-hide_banner', '-version'])]).then(
        () => true,
        () => false,
      ),
    );
  }
  return availability.get(key);
}

/**
 * Write a copy of `from` with the planned E-AC-3 tracks added to a hidden
 * partial file next to `to`, check it, give it its final name (never
 * overwriting), then delete `from`. On failure or cancel the partial file is
 * removed and `from` is left untouched.
 */
export async function convertAndMove(from, to, { plan, partialPath = partialPathFor(to), tools = {}, bitrate, signal, onProgress } = {}) {
  const source = await fs.stat(from);
  const reportFraction = (fraction) => onProgress?.(Math.min(source.size, Math.round(source.size * fraction)), source.size);
  try {
    await run(tools.ffmpeg ?? 'ffmpeg', buildFfmpegArgs({ input: from, output: partialPath, plan, bitrate }), {
      signal,
      onLine: (line) => {
        const seconds = parseProgressLine(line);
        if (seconds !== null && plan.duration) reportFraction(seconds / plan.duration);
      },
    });
    const result = await probeFile(partialPath, { ffprobe: tools.ffprobe, signal });
    const audio = result.streams.filter((stream) => stream.codec_type === 'audio');
    const added = audio.slice(plan.audioCount);
    if (audio.length !== plan.audioCount + plan.conversions.length || added.some((stream) => stream.codec_name !== 'eac3')) {
      throw new Error('The converted file does not contain the expected audio tracks');
    }
    const duration = Number(result.format?.duration);
    if (plan.duration && duration && Math.abs(duration - plan.duration) > Math.max(2, plan.duration * 0.01)) {
      throw new Error(`The converted file is ${duration.toFixed(1)}s long instead of ${plan.duration.toFixed(1)}s`);
    }
    await fs.chmod(partialPath, source.mode & 0o7777).catch(() => {});
    await fs.utimes(partialPath, source.atime, source.mtime).catch(() => {});
    if (signal?.aborted) throw new CancelledError();
    await commitNoOverwrite(partialPath, to);
  } catch (error) {
    await fs.rm(partialPath, { force: true }).catch(() => {});
    if (isCancellation(error) || signal?.aborted) throw new CancelledError();
    throw error;
  }
  reportFraction(1);
  await fs.unlink(from);
  return 'converted';
}
