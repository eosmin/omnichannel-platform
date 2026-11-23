// Runs the ffmpeg and ffprobe of the BUILT worker image (the `ffmpeg-build` stage of docker/node-service.Dockerfile) on the clips of the
// cleaner's specs, with the same command lines and the same checks as `FfmpegAvCleaner` (libs/core/storage/src/av-sanitizer.ts), and with no
// network. The specs run against the ffmpeg that CI installs; only this shows that the build the image ships (Alpine, musl, LGPL, demuxers
// and muxers only) copies every type the platform accepts, and that the copy is clean.
// Usage: tsx scripts/smoke-av-image.ts platform-worker:ci
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { exit } from 'node:process'

import { cleanArgs, parseProbe, probeArgs, verifyCleaned } from '@platform/core/av-sanitizer'
import { AvSanitizing } from '@platform/core/storage'

const image: string = process.argv[2] ?? ''
if (image === '') {
  console.error('usage: tsx scripts/smoke-av-image.ts <image>')
  exit(2)
}
const fixtures = resolve('apps/worker/src/media/__fixtures__/av')
const CLIPS: Array<[string, string]> = [
  ['dirty.mp4', 'video/mp4'],
  ['dirty-audio-first.mp4', 'video/mp4'],
  ['dirty.mov', 'video/quicktime'],
  ['dirty.m4a', 'audio/mp4'],
  ['dirty.mp3', 'audio/mpeg'],
  ['dirty.ogg', 'audio/ogg'],
  ['dirty.wav', 'audio/wav'],
  ['dirty.aac', 'audio/aac']
]

const dockerRun = (directory: string, tool: string, args: string[]): string =>
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--user',
      'node',
      '-v',
      `${directory}:/work`,
      '-w',
      '/work',
      '--entrypoint',
      AvSanitizing.PRLIMIT_PATH,
      image,
      `--as=${AvSanitizing.LIMIT_ADDRESS_SPACE_BYTES}`,
      `--cpu=${AvSanitizing.LIMIT_CPU_SECONDS}`,
      `--fsize=${AvSanitizing.LIMIT_FILE_BYTES}`,
      `--nofile=${AvSanitizing.LIMIT_OPEN_FILES}`,
      '--core=0',
      '--',
      tool,
      ...args
    ],
    { encoding: 'utf8', maxBuffer: AvSanitizing.MAX_PROBE_OUTPUT_BYTES }
  )

function main(): void {
  // The build: LGPL, and no protocol but `file`
  const banner = execFileSync(
    'docker',
    ['run', '--rm', '--entrypoint', AvSanitizing.FFMPEG_PATH, image, '-hide_banner', '-L'],
    {
      encoding: 'utf8'
    }
  )
  if (
    !/GNU Lesser General Public/i.test(banner) ||
    /GNU General Public License/i.test(banner.replace(/Lesser/gi, ''))
  ) {
    throw new Error('the ffmpeg of the image is not LGPL')
  }
  const protocols = execFileSync(
    'docker',
    ['run', '--rm', '--entrypoint', AvSanitizing.FFMPEG_PATH, image, '-hide_banner', '-protocols'],
    {
      encoding: 'utf8'
    }
  )
  const listed = protocols
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[a-z0-9_+]+$/.test(line))
  if (listed.join(',') !== 'file,file')
    throw new Error(`protocols of the image: ${listed.join(',')} (input and output of file only)`)

  for (const [name, type] of CLIPS) {
    const directory = mkdtempSync(join(tmpdir(), 'smoke-av-'))
    try {
      // The container runs as `node`, not as the user of the runner: it must be able to write the copy here
      chmodSync(directory, 0o777)
      copyFileSync(join(fixtures, name), join(directory, AvSanitizing.INPUT_FILE))
      const before = parseProbe(
        dockerRun(directory, AvSanitizing.FFPROBE_PATH, probeArgs(type, AvSanitizing.INPUT_FILE))
      )
      if (before === null) throw new Error(`${name}: the image cannot read the clip`)
      dockerRun(directory, AvSanitizing.FFMPEG_PATH, cleanArgs(type))
      const after = parseProbe(
        dockerRun(directory, AvSanitizing.FFPROBE_PATH, probeArgs(type, AvSanitizing.OUTPUT_FILE))
      )
      if (after === null) throw new Error(`${name}: the image cannot read the copy`)
      const refusal = verifyCleaned(
        before,
        after,
        readFileSync(join(directory, AvSanitizing.OUTPUT_FILE))
      )
      if (refusal !== null) throw new Error(`${name}: the copy is refused (${refusal})`)
      console.log(`ok ${name}`)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  exit(1)
}
