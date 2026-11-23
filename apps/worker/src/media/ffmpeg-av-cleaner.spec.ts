import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AvSanitizing } from '@platform/core/storage'

import { type AvToolOptions, FfmpegAvCleaner } from './ffmpeg-av-cleaner'

// The tools are replaced by two small node scripts, so the process side (the deadline, the empty environment, the group, the directory) is
// proved without a real ffmpeg. What decides the answer of the fake is the first bytes of the input file:
//   DIRTY  the probe says it carries a location tag; the copy is written and probes clean
//   CLEAN  the probe says it carries nothing
//   LEAVE  like DIRTY, but the "copy" keeps the tag (the check of the copy must refuse it)
//   HANG   the tool sleeps for ever and leaves a grandchild that sleeps too
//   NOISE  the probe prints more than it may
//   BROKEN the tool exits 1
//   SHORT  the copy is half as long
// Everything the fake sees (arguments, environment, cwd) is appended to a log file whose path is written into the script.
const script = (log: string, body: string): string => `#!${process.execPath}
const fs = require('fs')
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env), cwd: process.cwd(), pid: process.pid }) + '\\n')
${body}
`

const ffprobe = (log: string, work: string): string =>
  script(
    log,
    `
const file = process.argv[process.argv.length - 1]
const text = fs.readFileSync(file).toString('latin1')
if (text.startsWith('BROKEN')) process.exit(1)
if (text.startsWith('HANG')) { const grand = require('child_process').spawn('/bin/sleep', ['300'], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(join(work, 'grandchild.pid'))}, String(grand.pid)); setInterval(() => {}, 1000); return }
if (text.startsWith('NOISE')) { process.stdout.write('x'.repeat(${AvSanitizing.MAX_PROBE_OUTPUT_BYTES + 10})); return }
const dirty = file === 'input.bin' && (text.startsWith('DIRTY') || text.startsWith('SHORT'))
const tags = dirty || text.startsWith('LEAVE') ? { location: '+40.7-074.0/' } : {}
const duration = text.startsWith('SHORT') && file === 'output.bin' ? '0.5' : '1.0'
process.stdout.write(JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'aac', tags: {} }], format: { duration, tags } }))
`
  )

const ffmpeg = (log: string): string =>
  script(
    log,
    `
const text = fs.readFileSync('input.bin').toString('latin1')
if (text.startsWith('BROKEN')) process.exit(1)
if (text.startsWith('SHORT')) { fs.writeFileSync('output.bin', 'SHORT copy'); process.exit(0) }
fs.writeFileSync('output.bin', text.startsWith('LEAVE') ? text : 'cleaned bytes', 'latin1')
`
  )

describe('FfmpegAvCleaner', () => {
  let work: string
  let log: string
  const warn = jest.fn()

  const options = (over: Partial<AvToolOptions> = {}): AvToolOptions => ({
    ffmpegPath: join(work, 'ffmpeg'),
    ffprobePath: join(work, 'ffprobe'),
    prlimitPath: null,
    timeoutMs: 5000,
    maxInputBytes: 1024,
    ...over
  })
  const make = (over: Partial<AvToolOptions> = {}) => new FfmpegAvCleaner(options(over), { warn })
  const calls = (): Array<{ argv: string[]; env: string[]; cwd: string; pid: number }> =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { argv: string[]; env: string[]; cwd: string; pid: number })
  const cleanDirectories = (): string[] =>
    readdirSync(tmpdir()).filter(name => name.startsWith(AvSanitizing.TEMP_DIR_PREFIX))

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'av-fake-tools-'))
    log = join(work, 'calls.log')
    writeFileSync(log, '')
    writeFileSync(join(work, 'ffprobe'), ffprobe(log, work), { mode: 0o755 })
    writeFileSync(join(work, 'ffmpeg'), ffmpeg(log), { mode: 0o755 })
    warn.mockClear()
  })
  afterEach(() => {
    rmSync(work, { recursive: true, force: true })
  })

  it('returns the copy once it has been read back', async () => {
    const result = await make().clean(Buffer.from('DIRTY clip'), 'video/mp4', 'media-1')
    expect(result).toEqual({ kind: 'cleaned', body: Buffer.from('cleaned bytes') })
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not rewrite a file that carries nothing', async () => {
    const result = await make().clean(Buffer.from('CLEAN clip'), 'audio/mpeg', 'media-2')
    expect(result).toEqual({ kind: 'untouched', why: 'already_clean' })
    // one probe, no copy
    expect(calls()).toHaveLength(1)
  })

  it('runs every tool with an empty environment, no shell, in a private directory and with fixed arguments', async () => {
    const input = Buffer.from('DIRTY name; $(touch pwned) `id` clip')
    await make().clean(input, 'audio/aac', 'media-3')
    const seen = calls()
    expect(seen).toHaveLength(3)
    for (const call of seen) {
      // macOS adds one variable of its own to every process; any variable of the worker would show here
      expect(call.env.filter(key => key !== '__CF_USER_TEXT_ENCODING')).toEqual([])
      expect(call.cwd).toContain(AvSanitizing.TEMP_DIR_PREFIX)
      // the text of the file never reaches the arguments
      expect(call.argv.join(' ')).not.toContain('pwned')
      expect(call.argv.join(' ')).toContain('-protocol_whitelist file')
    }
    expect(seen[1]?.argv).toContain('-nostdin')
    expect(existsSync(join(work, 'pwned'))).toBe(false)
  })

  it('wraps the tool in prlimit with the limits, as a fixed command line', async () => {
    const prlimit = join(work, 'prlimit')
    writeFileSync(
      prlimit,
      `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(join(work, 'limits.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n')
const [tool, ...rest] = process.argv.slice(2).slice(process.argv.slice(2).indexOf('--') + 1)
require('child_process').execFileSync(tool, rest, { stdio: ['ignore', 'inherit', 'ignore'], env: {} })
`,
      { mode: 0o755 }
    )
    await make({ prlimitPath: prlimit }).clean(Buffer.from('DIRTY clip'), 'video/mp4', 'media-4')
    const [first] = readFileSync(join(work, 'limits.log'), 'utf8').split('\n').filter(Boolean)
    expect(JSON.parse(first ?? '[]')).toEqual(
      expect.arrayContaining([
        `--as=${AvSanitizing.LIMIT_ADDRESS_SPACE_BYTES}`,
        `--cpu=${AvSanitizing.LIMIT_CPU_SECONDS}`,
        `--fsize=${AvSanitizing.LIMIT_FILE_BYTES}`,
        `--nofile=${AvSanitizing.LIMIT_OPEN_FILES}`,
        '--core=0',
        '--'
      ])
    )
  })

  it('deletes its directory whatever the answer', async () => {
    const before = cleanDirectories().length
    for (const text of ['DIRTY a', 'CLEAN a', 'BROKEN a', 'LEAVE a', 'SHORT a']) {
      await make().clean(Buffer.from(text), 'video/mp4', 'media-5')
    }
    expect(cleanDirectories().length).toBe(before)
  })

  it('keeps the original when the tool fails', async () => {
    const input = Buffer.from('BROKEN clip')
    const copy = Buffer.from(input)
    expect(await make().clean(input, 'video/mp4', 'media-6')).toEqual({
      kind: 'untouched',
      why: 'not_cleanable'
    })
    expect(input.equals(copy)).toBe(true)
    expect(warn).toHaveBeenCalledWith(
      { mediaId: 'media-6', reason: 'not_cleanable' },
      expect.any(String)
    )
  })

  it('keeps the original when the copy still has the tag', async () => {
    expect(await make().clean(Buffer.from('LEAVE clip'), 'video/mp4', 'media-7')).toEqual({
      kind: 'untouched',
      why: 'not_cleanable'
    })
  })

  it('keeps the original when the copy is not as long', async () => {
    expect(await make().clean(Buffer.from('SHORT clip'), 'video/mp4', 'media-8')).toEqual({
      kind: 'untouched',
      why: 'not_cleanable'
    })
  })

  it('keeps the original when the probe prints too much', async () => {
    expect(await make().clean(Buffer.from('NOISE clip'), 'video/mp4', 'media-9')).toEqual({
      kind: 'untouched',
      why: 'not_cleanable'
    })
  })

  it('kills the tool and everything it started at the deadline', async () => {
    const started = Date.now()
    const result = await make({ timeoutMs: 600 }).clean(
      Buffer.from('HANG clip'),
      'video/mp4',
      'media-10'
    )
    expect(result).toEqual({ kind: 'untouched', why: 'timed_out' })
    expect(Date.now() - started).toBeLessThan(4000)
    // the child is gone, and so is the `sleep` it started (same group)
    const [call] = calls()
    expect(() => process.kill(call?.pid ?? 0, 0)).toThrow()
    const grandchild = Number(readFileSync(join(work, 'grandchild.pid'), 'utf8'))
    expect(grandchild).toBeGreaterThan(1)
    await new Promise(done => setTimeout(done, 200))
    expect(() => process.kill(grandchild, 0)).toThrow()
    expect(warn).toHaveBeenCalledWith(
      { mediaId: 'media-10', reason: 'timed_out' },
      expect.any(String)
    )
  })

  it('leaves what it does not clean alone, with no tool started', async () => {
    expect(await make().clean(Buffer.from('x'), 'image/png', 'media-11')).toEqual({
      kind: 'untouched',
      why: 'type'
    })
    expect(await make().clean(Buffer.alloc(2000), 'video/mp4', 'media-12')).toEqual({
      kind: 'untouched',
      why: 'too_large'
    })
    expect(calls()).toHaveLength(0)
  })

  it('throws, so that the queue retries, when the tool is not there', async () => {
    const before = cleanDirectories().length
    await expect(
      make({ ffprobePath: join(work, 'missing') }).clean(
        Buffer.from('DIRTY clip'),
        'video/mp4',
        'media-13'
      )
    ).rejects.toThrow('could not be started')
    expect(cleanDirectories().length).toBe(before)
  })

  it.each([
    ['ffmpeg', 'ffmpegPath'],
    ['ffprobe', 'ffprobePath']
  ] as const)(
    'throws when prlimit runs and %s is not there (exit 127), so that the queue retries',
    async (_tool, option) => {
      // A prlimit that behaves as the real one does when the tool is missing: it exits 127 and no spawn error happens
      const prlimit = join(work, 'prlimit')
      writeFileSync(
        prlimit,
        `#!${process.execPath}
const args = process.argv.slice(2)
const tool = args[args.indexOf('--') + 1]
process.exit(require('fs').existsSync(tool) ? require('child_process').spawnSync(tool, args.slice(args.indexOf('--') + 2), { stdio: ['ignore', 'inherit', 'ignore'], env: {} }).status ?? 1 : 127)
`,
        { mode: 0o755 }
      )
      const before = cleanDirectories().length
      await expect(
        make({ prlimitPath: prlimit, [option]: join(work, 'missing') }).clean(
          Buffer.from('DIRTY clip'),
          'video/mp4',
          'media-15'
        )
      ).rejects.toThrow('could not be started')
      expect(cleanDirectories().length).toBe(before)
      expect(warn).not.toHaveBeenCalled()
    }
  )

  it('logs the id and the reason and never the name of the file or what the tool printed', async () => {
    await make().clean(Buffer.from('BROKEN secret-name.mp4'), 'video/mp4', 'media-14')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-name')
  })
})
