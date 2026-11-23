import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { AvSanitizing } from '@platform/core/storage'

import { defaultAvToolOptions, FfmpegAvCleaner } from './ffmpeg-av-cleaner'

// The cleaner against a REAL ffmpeg and ffprobe, on small clips that carry a fake place, time, model and name on purpose
// (`__fixtures__/av/generate.sh`). CI installs ffmpeg for this job (apt, `/usr/bin`; a failed install stops the job); the worker image
// carries its own build, which the image job runs against the same clips (`scripts/smoke-av-image.ts`). On a machine that has neither
// the suite is skipped.
const SYSTEM_FFMPEG = '/usr/bin/ffmpeg'
const SYSTEM_FFPROBE = '/usr/bin/ffprobe'
const shipped = existsSync(AvSanitizing.FFMPEG_PATH)
const tools = {
  ...defaultAvToolOptions(),
  ffmpegPath: shipped ? AvSanitizing.FFMPEG_PATH : SYSTEM_FFMPEG,
  ffprobePath: shipped ? AvSanitizing.FFPROBE_PATH : SYSTEM_FFPROBE
}
const available =
  existsSync(tools.ffmpegPath) &&
  existsSync(tools.ffprobePath) &&
  spawnSync(tools.ffprobePath, ['-version'], { env: {} }).status === 0

const fixture = (name: string): Buffer => readFileSync(join(__dirname, '__fixtures__', 'av', name))

// What a person would look for in the copy: the fake place, time, model and names of the fixtures
const LEAKS = ['PhoneX', 'Someone', 'secret', 'SecretHandler', '+40.7128', 'ISO6709', '2024-05-01']

const probe = (body: Buffer, format: string): string =>
  spawnSync(
    tools.ffprobePath,
    ['-v', 'error', '-show_format', '-show_streams', '-f', format, '-i', 'pipe:0'],
    { input: body, env: {}, encoding: 'utf8' }
  ).stdout

const cleaner = new FfmpegAvCleaner(tools, { warn: jest.fn() })

const maybe = available ? describe : describe.skip

maybe('FfmpegAvCleaner with the real tools', () => {
  it.each([
    ['dirty.mp4', 'video/mp4', 'mov'],
    ['dirty-audio-first.mp4', 'video/mp4', 'mov'],
    ['dirty.mov', 'video/quicktime', 'mov'],
    ['dirty.m4a', 'audio/mp4', 'mov'],
    ['dirty.mp3', 'audio/mpeg', 'mp3'],
    ['dirty.ogg', 'audio/ogg', 'ogg'],
    ['dirty.wav', 'audio/wav', 'wav'],
    ['dirty.aac', 'audio/aac', 'aac']
  ])(
    'cuts the metadata out of %s and keeps the streams and the length',
    async (name, type, format) => {
      const original = fixture(name)
      const before = probe(original, format)
      expect(before).toMatch(/TAG:(location|artist|comment|ARTIST|COMMENT)=|TAG:.*Someone|PhoneX/i)

      const result = await cleaner.clean(original, type, 'media-real')
      if (result.kind !== 'cleaned') throw new Error(`not cleaned: ${result.why}`)

      const after = probe(result.body, format)
      for (const leak of LEAKS) {
        expect(result.body.includes(leak)).toBe(false)
        expect(after).not.toContain(leak)
      }
      expect(after).not.toMatch(/TAG:(location|creation_time|model|artist|comment|encoder)/i)
      // same codecs and same length
      const field = (text: string, key: string): string[] =>
        [...text.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))].map(match => match[1] ?? '')
      expect(field(after, 'codec_name')).toEqual(field(before, 'codec_name'))
      const [lengthBefore] = field(before, 'duration').slice(-1)
      const [lengthAfter] = field(after, 'duration').slice(-1)
      expect(Math.abs(Number(lengthBefore) - Number(lengthAfter))).toBeLessThan(0.25)
      // the original was not touched and a second pass finds nothing to cut
      expect(original.equals(fixture(name))).toBe(true)
      expect(await cleaner.clean(result.body, type, 'media-real')).toEqual({
        kind: 'untouched',
        why: 'already_clean'
      })
    }
  )

  it('leaves a file that carries nothing as it is', async () => {
    expect(await cleaner.clean(fixture('clean.mp3'), 'audio/mpeg', 'media-real')).toEqual({
      kind: 'untouched',
      why: 'already_clean'
    })
  })

  it('cuts the cover picture out of an audio file', async () => {
    const result = await cleaner.clean(fixture('dirty-cover.mp3'), 'audio/mpeg', 'media-real')
    if (result.kind !== 'cleaned') throw new Error('not cleaned')
    expect(probe(result.body, 'mp3')).not.toContain('codec_type=video')
  })

  it('cuts an ID3 tag off the start of an aac', async () => {
    const result = await cleaner.clean(fixture('dirty-id3.aac'), 'audio/aac', 'media-real')
    if (result.kind !== 'cleaned') throw new Error('not cleaned')
    expect(result.body.subarray(0, 3).toString('latin1')).not.toBe('ID3')
  })

  it('keeps, and does not throw on, bytes that are not what the type says', async () => {
    const garbage = Buffer.from(Array.from({ length: 4000 }, (_, index) => (index * 31) % 251))
    for (const type of Object.keys(AvSanitizing.FORMATS)) {
      expect(await cleaner.clean(garbage, type, 'media-real')).toEqual({
        kind: 'untouched',
        why: 'not_cleanable'
      })
    }
    expect(await cleaner.clean(Buffer.alloc(0), 'video/mp4', 'media-real')).toEqual({
      kind: 'untouched',
      why: 'not_cleanable'
    })
  })

  it('keeps the original of a file that is cut short (never a half file in its place)', async () => {
    const whole = fixture('dirty.mp4')
    const result = await cleaner.clean(
      whole.subarray(0, Math.floor(whole.length / 2)),
      'video/mp4',
      'media-real'
    )
    if (result.kind === 'cleaned') {
      // if the tools could read it, what came back must still be clean and not empty
      expect(result.body.length).toBeGreaterThan(0)
      expect(result.body.includes('PhoneX')).toBe(false)
    } else {
      expect(result.why).toBe('not_cleanable')
    }
  })

  it('does not take a file for the type of another one', async () => {
    expect(await cleaner.clean(fixture('dirty.mp3'), 'video/mp4', 'media-real')).toEqual({
      kind: 'untouched',
      why: 'not_cleanable'
    })
  })

  it('does not follow a name inside the file (a playlist or a concat list is not read)', async () => {
    const concat = Buffer.from("ffconcat version 1.0\nfile '/etc/hostname'\n")
    expect(await cleaner.clean(concat, 'audio/mpeg', 'media-real')).toEqual({
      kind: 'untouched',
      why: 'not_cleanable'
    })
  })
})
