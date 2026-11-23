import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PinoLogger } from 'nestjs-pino'

import {
  carriesMetadata,
  cleanArgs,
  isCleanableType,
  parseProbe,
  probeArgs,
  verifyCleaned
} from '@platform/core/av-sanitizer'
import { withDecodeSlot } from '@platform/core/image-sanitizer'
import { AvSanitizing, UploadLimits } from '@platform/core/storage'

import { AvCleaner, type AvUntouchedReason, type CleanedAv } from './av-cleaner'

const { Untouched, Results } = AvSanitizing

export interface AvToolOptions {
  ffmpegPath: string
  ffprobePath: string
  // The wrapper that sets the limits of the kernel on the child; null runs the tool with the deadline alone (a machine that has no
  // `prlimit`, such as a laptop). The image of the worker has it, and the build checks it
  prlimitPath: string | null
  timeoutMs: number
  maxInputBytes: number
}

export const defaultAvToolOptions = (): AvToolOptions => ({
  ffmpegPath: AvSanitizing.FFMPEG_PATH,
  ffprobePath: AvSanitizing.FFPROBE_PATH,
  prlimitPath: existsSync(AvSanitizing.PRLIMIT_PATH) ? AvSanitizing.PRLIMIT_PATH : null,
  timeoutMs: AvSanitizing.TOOL_TIMEOUT_MS,
  maxInputBytes: UploadLimits.MAX_FILE_SIZE_BYTES
})

interface ToolRun {
  // Exit code, or null when the child was killed (deadline, output too long) or did not start
  code: number | null
  stdout: Buffer
  timedOut: boolean
  tooMuchOutput: boolean
}

// The tool is not there or cannot be started: the machine's fault, not the file's
class AvToolUnavailable extends Error {
  constructor() {
    super('the video and audio tools could not be started')
  }
}

const killGroup = (child: ChildProcess): void => {
  // The child leads a process group of its own (`detached`), so a negative pid reaches whatever it started too
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // Already gone
  }
}

// Cleans the metadata of a video or an audio file with ffmpeg, in a child process for each step (`FfmpegAvCleaner`). The file is the stranger's:
// the child gets an empty environment, no shell, no stdin, a private directory that is deleted afterwards, a command line that is all
// constants (`av-sanitizer.ts`: the type picks a row of a table, the file names are fixed and the child runs with that directory as its cwd),
// no network (the binary has no sockets, and only the `file` protocol) and, through `prlimit`, a cap on memory, CPU, file size and open files,
// besides the deadline. At the deadline the child and its group are killed. One file at a time per worker process, in the decode slot that
// the pictures share, so two files never hold two children.
// What comes out is read back (`verifyCleaned`) before it is handed over: the original is replaced by the caller only with a verified copy.
export class FfmpegAvCleaner extends AvCleaner {
  constructor(
    private readonly options: AvToolOptions,
    private readonly logger: Pick<PinoLogger, 'warn'>
  ) {
    super()
  }

  clean(input: Buffer, contentType: string, id: string): Promise<CleanedAv> {
    if (!isCleanableType(contentType)) {
      return Promise.resolve({ kind: Results.UNTOUCHED, why: Untouched.TYPE })
    }
    if (input.length > this.options.maxInputBytes) {
      return Promise.resolve(this.kept(id, Untouched.TOO_LARGE))
    }
    return withDecodeSlot(() => this.cleanInDirectory(input, contentType, id))
  }

  private kept(id: string, why: AvUntouchedReason): CleanedAv {
    // Id and reason only: what a tool prints may carry a piece of the file
    this.logger.warn({ mediaId: id, reason: why }, 'a video or audio file was kept as it came')
    return { kind: Results.UNTOUCHED, why }
  }

  private async cleanInDirectory(
    input: Buffer,
    contentType: string,
    id: string
  ): Promise<CleanedAv> {
    // 0700: nobody but this process reads the file while it is here
    const directory = await mkdtemp(join(tmpdir(), AvSanitizing.TEMP_DIR_PREFIX))
    try {
      await writeFile(join(directory, AvSanitizing.INPUT_FILE), input, { mode: 0o600 })
      return await this.cleanFile(directory, input, contentType, id)
    } finally {
      // The directory is the one made above, never a path that came from the file
      await rm(directory, { recursive: true, force: true })
    }
  }

  private async cleanFile(
    directory: string,
    input: Buffer,
    contentType: string,
    id: string
  ): Promise<CleanedAv> {
    const before = await this.probe(directory, contentType, AvSanitizing.INPUT_FILE)
    if (before === Untouched.TIMED_OUT) return this.kept(id, Untouched.TIMED_OUT)
    if (before === null) return this.kept(id, Untouched.NOT_CLEANABLE)
    if (!carriesMetadata(before, input))
      return { kind: Results.UNTOUCHED, why: Untouched.ALREADY_CLEAN }

    const copy = await this.run(directory, this.options.ffmpegPath, cleanArgs(contentType))
    if (copy.timedOut) return this.kept(id, Untouched.TIMED_OUT)
    if (copy.code !== 0) return this.kept(id, Untouched.NOT_CLEANABLE)

    const written = await stat(join(directory, AvSanitizing.OUTPUT_FILE)).catch(() => null)
    if (written === null || !written.isFile() || written.size > this.options.maxInputBytes) {
      return this.kept(id, Untouched.NOT_CLEANABLE)
    }
    const after = await this.probe(directory, contentType, AvSanitizing.OUTPUT_FILE)
    if (after === Untouched.TIMED_OUT) return this.kept(id, Untouched.TIMED_OUT)
    if (after === null) return this.kept(id, Untouched.NOT_CLEANABLE)
    // The bytes that are checked are the bytes that are returned: the child is dead and the directory is private
    const body = await readFile(join(directory, AvSanitizing.OUTPUT_FILE))
    if (verifyCleaned(before, after, body) !== null) return this.kept(id, Untouched.NOT_CLEANABLE)
    return { kind: Results.CLEANED, body }
  }

  private async probe(directory: string, contentType: string, file: string) {
    const answer = await this.run(directory, this.options.ffprobePath, probeArgs(contentType, file))
    if (answer.timedOut) return Untouched.TIMED_OUT
    if (answer.code !== 0 || answer.tooMuchOutput) return null
    return parseProbe(answer.stdout.toString('utf8'))
  }

  private run(directory: string, tool: string, args: string[]): Promise<ToolRun> {
    const limits = this.options.prlimitPath
    const [command, argv] =
      limits === null
        ? [tool, args]
        : [
            limits,
            [
              `--as=${AvSanitizing.LIMIT_ADDRESS_SPACE_BYTES}`,
              `--cpu=${AvSanitizing.LIMIT_CPU_SECONDS}`,
              `--fsize=${AvSanitizing.LIMIT_FILE_BYTES}`,
              `--nofile=${AvSanitizing.LIMIT_OPEN_FILES}`,
              '--core=0',
              '--',
              tool,
              ...args
            ]
          ]
    return new Promise<ToolRun>((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let timedOut = false
      let tooMuchOutput = false
      let child: ChildProcess
      try {
        child = spawn(command, argv, {
          cwd: directory,
          // Nothing of the worker reaches the tool: no database address, no key
          env: {},
          shell: false,
          detached: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true
        })
      } catch {
        reject(new AvToolUnavailable())
        return
      }
      const timer = setTimeout(() => {
        timedOut = true
        killGroup(child)
      }, this.options.timeoutMs)
      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > AvSanitizing.MAX_PROBE_OUTPUT_BYTES) {
          tooMuchOutput = true
          killGroup(child)
          return
        }
        chunks.push(chunk)
      })
      child.once('error', () => {
        clearTimeout(timer)
        killGroup(child)
        reject(new AvToolUnavailable())
      })
      child.once('close', code => {
        clearTimeout(timer)
        // A tool that ended on its own leaves nothing to kill, and its group id may be someone else's by now: only a child that was stopped
        // (deadline, output) has its group killed again, which is when a grandchild can still be running
        if (timedOut || tooMuchOutput) killGroup(child)
        resolve({ code, stdout: Buffer.concat(chunks), timedOut, tooMuchOutput })
      })
    })
  }
}
