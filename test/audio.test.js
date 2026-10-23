import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  audioToolsAvailable,
  buildFfmpegArgs,
  convertAndMove,
  languageAliases,
  parseProgressLine,
  planAudioFix,
  probeFile,
} from '../lib/audio.ts';
import { CancelledError } from '../lib/mover.ts';

const run = promisify(execFile);
const hasFfmpeg = await audioToolsAvailable();
const withFfmpeg = { skip: hasFfmpeg ? false : 'ffmpeg/ffprobe not installed (runs in the Docker image)' };

const stream = (index, codec_type, codec_name, language, extra = {}) => ({ index, codec_type, codec_name, ...(language && { tags: { language } }), ...extra });

test('language aliases cover 2- and 3-letter codes', () => {
  assert.deepEqual([...languageAliases('de')], ['de', 'ger', 'deu']);
  assert.ok(languageAliases('GER').has('de'));
  assert.deepEqual([...languageAliases('xx')], ['xx']);
});

test('converts a German DTS track when there is no German Dolby track', () => {
  const probe = {
    streams: [
      stream(0, 'video', 'h264'),
      stream(1, 'audio', 'dts', 'ger', { channels: 8, profile: 'DTS-HD MA' }),
      stream(2, 'audio', 'ac3', 'eng', { channels: 6 }),
      stream(3, 'subtitle', 'subrip', 'ger'),
    ],
    format: { duration: '5400.5' },
  };
  const plan = planAudioFix(probe, { languages: ['de'] });
  assert.equal(plan.action, 'convert');
  assert.equal(plan.audioCount, 2);
  assert.equal(plan.duration, 5400.5);
  assert.deepEqual(plan.conversions, [{ streamIndex: 1, language: 'ger', channels: 8, outputChannels: 6, source: 'DTS-HD MA' }]);
});

test('skips files that already have a Dolby track in the language, or no DTS at all', () => {
  const withAc3 = planAudioFix({ streams: [stream(0, 'audio', 'dts', 'ger'), stream(1, 'audio', 'ac3', 'deu')] }, { languages: ['de'] });
  assert.deepEqual([withAc3.action, withAc3.reason], ['skip', 'de: already has a Dolby track']);
  const withAtmos = planAudioFix({ streams: [stream(0, 'audio', 'dts', 'ger'), stream(1, 'audio', 'truehd', 'ger')] }, { languages: ['de'] });
  assert.equal(withAtmos.action, 'skip');
  const englishOnly = planAudioFix({ streams: [stream(0, 'audio', 'dts', 'eng')] }, { languages: ['de'] });
  assert.deepEqual([englishOnly.action, englishOnly.reason], ['skip', 'de: no DTS track']);
  const untagged = planAudioFix({ streams: [stream(0, 'audio', 'dts')] }, { languages: ['de'] });
  assert.equal(untagged.action, 'skip', 'untagged tracks are not guessed');
});

test('handles several languages, one new track each', () => {
  const probe = { streams: [stream(0, 'audio', 'dts', 'ger', { channels: 6 }), stream(1, 'audio', 'dts', 'eng', { channels: 2 })] };
  const plan = planAudioFix(probe, { languages: ['de', 'en'] });
  assert.deepEqual(plan.conversions.map((c) => [c.streamIndex, c.language]), [[0, 'ger'], [1, 'eng']]);
});

test('ffmpeg keeps every original stream and appends E-AC-3 tracks', () => {
  const plan = {
    audioCount: 2,
    conversions: [
      { streamIndex: 1, language: 'ger', channels: 8, outputChannels: 6, source: 'DTS-HD MA' },
      { streamIndex: 2, language: 'eng', channels: 2, outputChannels: 2, source: 'DTS' },
    ],
  };
  const args = buildFfmpegArgs({ input: 'in.mkv', output: 'out.mkv', plan, bitrate: '1024k' });
  const joined = args.join(' ');
  assert.match(joined, /-map 0 -map 0:1 -map 0:2 -c copy/);
  assert.match(joined, /-c:a:2 eac3 -b:a:2 1024k -ac:a:2 6/, 'the 7.1 source is downmixed to 5.1');
  assert.match(joined, /-c:a:3 eac3 -b:a:3 256k -metadata/, 'stereo gets a stereo bitrate and no downmix');
  assert.ok(args.includes('title=Dolby Digital Plus 5.1 (converted from DTS-HD MA)'));
  assert.ok(args.includes('language=ger'));
  assert.deepEqual(args.slice(-3), ['-f', 'matroska', 'out.mkv']);
  assert.ok(!args.includes('-y'), 'never overwrites');
});

test('reads progress from ffmpeg -progress output', () => {
  assert.equal(parseProgressLine('out_time_us=1500000'), 1.5);
  assert.equal(parseProgressLine('out_time_ms=2000000'), 2, 'out_time_ms is in microseconds too');
  assert.equal(parseProgressLine('progress=continue'), null);
});

async function makeSample(dir, name, { audio = 'dts', language = 'ger', seconds = 3 } = {}) {
  const file = path.join(dir, name);
  const codec = audio === 'dts' ? ['-c:a', 'dca', '-strict', '-2', '-b:a', '768k'] : ['-c:a', audio];
  await run('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=160x90:r=10:d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', ...codec, '-ac', '6',
    '-metadata:s:a:0', `language=${language}`, file,
  ]);
  return file;
}

test('converts a real DTS file into a new file with an added E-AC-3 track', withFfmpeg, async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mr-audio-')));
  const source = await makeSample(dir, 'movie.mkv');
  const plan = planAudioFix(await probeFile(source), { languages: ['de'] });
  assert.equal(plan.action, 'convert');

  const fractions = [];
  const target = path.join(dir, 'library', 'Movie (2020).mkv');
  await fs.mkdir(path.dirname(target));
  await convertAndMove(source, target, { plan, bitrate: '640k', onProgress: (done, total) => fractions.push(done / total) });

  const result = await probeFile(target);
  const audio = result.streams.filter((s) => s.codec_type === 'audio');
  assert.deepEqual(audio.map((s) => [s.codec_name, s.tags?.language]), [['dts', 'ger'], ['eac3', 'ger']], 'original DTS kept, E-AC-3 added');
  assert.equal(audio[1].channels, 6);
  assert.match(audio[1].tags?.title ?? '', /Dolby Digital Plus 5\.1/);
  assert.equal(result.streams.filter((s) => s.codec_type === 'video').length, 1);
  await assert.rejects(fs.access(source), 'the download copy is removed after a successful conversion');
  assert.equal(fractions.at(-1), 1);
  assert.deepEqual((await fs.readdir(path.dirname(target))).sort(), ['Movie (2020).mkv'], 'no partial file left');
});

test('a cancelled conversion leaves the original and no partial file', withFfmpeg, async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mr-audio-')));
  const source = await makeSample(dir, 'long.mkv', { seconds: 120 });
  const plan = planAudioFix(await probeFile(source), { languages: ['de'] });
  const controller = new AbortController();
  const target = path.join(dir, 'out.mkv');
  await assert.rejects(
    convertAndMove(source, target, { plan, signal: controller.signal, onProgress: () => controller.abort() }),
    CancelledError,
  );
  assert.deepEqual(await fs.readdir(dir), ['long.mkv']);
});

test('refuses to overwrite an existing target', withFfmpeg, async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mr-audio-')));
  const source = await makeSample(dir, 'movie.mkv');
  const plan = planAudioFix(await probeFile(source), { languages: ['de'] });
  await fs.writeFile(path.join(dir, 'taken.mkv'), 'existing');
  await assert.rejects(convertAndMove(source, path.join(dir, 'taken.mkv'), { plan }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(dir, 'taken.mkv'), 'utf8'), 'existing');
  await fs.access(source);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['movie.mkv', 'taken.mkv']);
});
