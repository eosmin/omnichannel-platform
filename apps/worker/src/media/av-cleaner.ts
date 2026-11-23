import type { AvSanitizing } from '@platform/core/storage'

// What the worker uses to cut the metadata out of a video or an audio file (Step 7.1-J-1). The one implementation runs ffmpeg in a process of
// its own (`FfmpegAvCleaner`). An abstract class, not an interface, so that Nest can use it as the token. It never refuses a file and never
// loses one: what it cannot clean without risk comes back `untouched` and the caller keeps the original and records the id. An error of the
// machine (the tool is missing, no process can be started) is thrown, so that the queue retries.
export type AvUntouchedReason = (typeof AvSanitizing.Untouched)[keyof typeof AvSanitizing.Untouched]

export type CleanedAv =
  { kind: 'cleaned'; body: Buffer } | { kind: 'untouched'; why: AvUntouchedReason }

export abstract class AvCleaner {
  // `id` is the id of the media row: it is what the log says when a file is kept as it came (never the name, never a piece of the file)
  abstract clean(input: Buffer, contentType: string, id: string): Promise<CleanedAv>
}
