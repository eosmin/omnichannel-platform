import { z } from 'zod'

import { AvSanitizing } from '@platform/core/storage'

// The pure half of the cleaning of video and audio (Step 7.1-J-1): the command lines, the reading of what ffprobe says and the checks that
// decide whether a copy may replace the original. It runs nothing and touches no file; `FfmpegAvCleaner` (apps/worker) runs the tools.
// The channel is not named anywhere here (rule 13): the types come from `AllowedContentTypes` through `AvSanitizing.FORMATS`.

const { ALLOWED_TAGS, FORMATS, INPUT_FILE, OUTPUT_FILE, Refusals } = AvSanitizing

// What of the output of ffprobe is read. Anything else in it is ignored. A value that is not what it should be makes the probe fail
// (the file is then kept as it came), it is never trusted
const tagsSchema = z.record(z.string(), z.string()).optional()
const streamSchema = z.object({
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  disposition: z.object({ attached_pic: z.number().optional() }).partial().optional(),
  tags: tagsSchema
})
const probeSchema = z.object({
  streams: z.array(streamSchema).max(64),
  format: z.object({ duration: z.string().optional(), tags: tagsSchema })
})

export interface AvStream {
  type: string
  codec: string
  attachedPicture: boolean
  tags: Readonly<Record<string, string>>
}

export interface AvProbe {
  streams: readonly AvStream[]
  durationSeconds: number
  formatTags: Readonly<Record<string, string>>
}

export const isCleanableType = (contentType: string): boolean =>
  Object.prototype.hasOwnProperty.call(FORMATS, contentType)

// The arguments of `ffprobe` for a type: all constants. The format is named, so the file cannot pass for another one, and only the
// `file` protocol exists in the binary
export const probeArgs = (contentType: string, file: string): string[] => {
  const format = FORMATS[contentType]
  if (format === undefined) throw new Error('not a type of video or audio')
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-protocol_whitelist',
    'file',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-f',
    format.input,
    '-i',
    file
  ]
}

// The arguments of `ffmpeg` that copy the streams into a container with no metadata. All constants (the type picks a row of a table)
export const cleanArgs = (contentType: string): string[] => {
  const format = FORMATS[contentType]
  if (format === undefined) throw new Error('not a type of video or audio')
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-protocol_whitelist',
    'file',
    '-f',
    format.input,
    '-i',
    INPUT_FILE,
    // The video and audio streams only: data tracks (the GPS track of an action camera, the timecode) and subtitles are not carried
    '-map',
    '0:v?',
    '-map',
    '0:a?',
    // Global tags, the tags of every stream and the chapters
    '-map_metadata',
    '-1',
    '-map_metadata:s',
    '-1',
    '-map_chapters',
    '-1',
    '-c',
    'copy',
    // No encoder name and no time of writing in the new file
    '-fflags',
    '+bitexact',
    '-flags:v',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    ...format.args,
    '-f',
    format.output,
    OUTPUT_FILE
  ]
}

// Reads the JSON that ffprobe printed. Returns null for anything that is not what was asked for, which the caller treats as a file that
// cannot be cleaned
export const parseProbe = (text: string): AvProbe | null => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = probeSchema.safeParse(raw)
  if (!parsed.success) return null
  const duration =
    parsed.data.format.duration === undefined ? Number.NaN : Number(parsed.data.format.duration)
  return {
    streams: parsed.data.streams.map(stream => ({
      type: stream.codec_type ?? '',
      codec: stream.codec_name ?? '',
      attachedPicture: stream.disposition?.attached_pic === 1,
      tags: stream.tags ?? {}
    })),
    durationSeconds: duration,
    formatTags: parsed.data.format.tags ?? {}
  }
}

const allowedTags: ReadonlyMap<string, RegExp> = new Map(
  Object.entries(ALLOWED_TAGS).map(([key, pattern]) => [key, new RegExp(pattern)])
)

// The tag keys of a probe (format and streams) that are not the ones a muxer writes by itself, or whose value is not the one it writes. A key is
// compared in lowercase (mp4 tags come in any case; ogg ones in upper)
const strangeTags = (probe: AvProbe): string[] => {
  const found: string[] = []
  for (const tags of [probe.formatTags, ...probe.streams.map(stream => stream.tags)]) {
    for (const [key, value] of Object.entries(tags)) {
      if (allowedTags.get(key.toLowerCase())?.test(value) !== true) found.push(key)
    }
  }
  return found
}

const hasBytes = (body: Buffer, pattern: string): boolean => body.includes(pattern, 0, 'latin1')

// An ID3v2 tag at the very start (an mp3 or an aac that begins with one) that holds something. Bytes 6 to 9 are the size of its body, four
// numbers of seven bits. The muxer of mp3 writes a header with a body of padding (zeros) even when told to write no tag, and that holds
// nothing; a tag whose body has any other byte, or whose size runs past the file, is a tag
const startsWithId3Tag = (body: Buffer): boolean => {
  const header = AvSanitizing.ID3_HEADER_BYTES
  if (body.length < header) return false
  if (
    body.subarray(0, AvSanitizing.ID3_MAGIC.length).toString('latin1') !== AvSanitizing.ID3_MAGIC
  ) {
    return false
  }
  const size = body.subarray(6, header).reduce((total, byte) => total * 128 + (byte & 0x7f), 0)
  if (header + size > body.length) return true
  return body.subarray(header, header + size).some(byte => byte !== 0)
}

// Whether the bytes name where or with what the file was made, apart from the tags: the long names of `FORBIDDEN_BYTE_PATTERNS`, and an ID3
// tag with a body at the very start
export const namesTheSource = (body: Buffer): boolean =>
  AvSanitizing.FORBIDDEN_BYTE_PATTERNS.some(pattern => hasBytes(body, pattern)) ||
  startsWithId3Tag(body)

// Whether the file, as it came, has something the copy would take out: a tag, a cover picture, a data stream, or a name in its bytes. A file
// that carries nothing is not rewritten (the sweep would otherwise write the same bytes again every time)
export const carriesMetadata = (probe: AvProbe, body: Buffer): boolean =>
  strangeTags(probe).length > 0 ||
  probe.streams.some(stream => stream.attachedPicture || stream.type === 'data') ||
  namesTheSource(body)

const isMedia = (stream: AvStream): boolean =>
  (stream.type === 'video' || stream.type === 'audio') && !stream.attachedPicture

// Why the copy may not replace the original, or null when it may. The copy must be a file the tools can read back, with the same video and
// audio streams (kind and codec; the copy writes every video stream and then every audio stream, as `cleanArgs` maps them), the same length
// (within the tolerance), no cover picture, no tag that is not the muxer's own, and no name of the source in its bytes. A cover that was in a
// video file comes out in the copy and fails here: the file is kept
export const verifyCleaned = (before: AvProbe, after: AvProbe, output: Buffer): string | null => {
  if (output.length === 0) return Refusals.EMPTY
  const media = before.streams.filter(isMedia)
  const wanted = [
    ...media.filter(stream => stream.type === 'video'),
    ...media.filter(stream => stream.type === 'audio')
  ]
  const got = after.streams
  if (wanted.length === 0) return Refusals.NO_MEDIA_STREAM
  if (got.some(stream => stream.attachedPicture)) return Refusals.COVER_KEPT
  if (got.some(stream => stream.type === 'data')) return Refusals.DATA_KEPT
  if (got.length !== wanted.length) return Refusals.STREAMS_CHANGED
  for (const [index, stream] of wanted.entries()) {
    const copy = got[index]
    if (copy === undefined || copy.type !== stream.type || copy.codec !== stream.codec) {
      return Refusals.STREAMS_CHANGED
    }
  }
  if (!Number.isFinite(before.durationSeconds) || !Number.isFinite(after.durationSeconds)) {
    return Refusals.DURATION_UNKNOWN
  }
  const tolerance = Math.max(
    AvSanitizing.DURATION_TOLERANCE_SECONDS,
    before.durationSeconds * AvSanitizing.DURATION_TOLERANCE_RATIO
  )
  if (Math.abs(before.durationSeconds - after.durationSeconds) > tolerance) {
    return Refusals.DURATION_CHANGED
  }
  if (strangeTags(after).length > 0) return Refusals.TAGS_KEPT
  if (namesTheSource(output)) return Refusals.SOURCE_NAMED
  return null
}
