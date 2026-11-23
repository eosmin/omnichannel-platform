import { AllowedContentTypes, AvSanitizing } from '@platform/core/storage'

import {
  type AvProbe,
  carriesMetadata,
  cleanArgs,
  isCleanableType,
  namesTheSource,
  parseProbe,
  probeArgs,
  verifyCleaned
} from './av-sanitizer'

const stream = (
  type: string,
  codec: string,
  extra: Partial<{ attachedPicture: boolean; tags: Record<string, string> }> = {}
) => ({ type, codec, attachedPicture: false, tags: {}, ...extra })

const probe = (over: Partial<AvProbe> = {}): AvProbe => ({
  streams: [stream('video', 'h264'), stream('audio', 'aac')],
  durationSeconds: 10,
  formatTags: {},
  ...over
})

const BODY = Buffer.from('plain bytes of a clip')

describe('the types the cleaner takes', () => {
  it('has a row for every video and audio type that uploads accept, and none for anything else', () => {
    const accepted = [...AllowedContentTypes.VIDEO, ...AllowedContentTypes.AUDIO].sort()
    expect(Object.keys(AvSanitizing.FORMATS).sort()).toEqual(accepted)
    for (const type of accepted) expect(isCleanableType(type)).toBe(true)
    for (const type of [...AllowedContentTypes.IMAGE, ...AllowedContentTypes.DOCUMENT]) {
      expect(isCleanableType(type)).toBe(false)
    }
    // A name from the prototype chain is not a type
    expect(isCleanableType('constructor')).toBe(false)
    expect(isCleanableType('__proto__')).toBe(false)
  })
})

describe('the command lines', () => {
  it('copy the streams and drop every kind of metadata, with fixed arguments', () => {
    for (const type of Object.keys(AvSanitizing.FORMATS)) {
      const args = cleanArgs(type)
      expect(args).toEqual(
        expect.arrayContaining(['-nostdin', '-c', 'copy', '-fflags', '+bitexact'])
      )
      // global tags, tags of the streams, chapters: each one is cut
      expect(args.join(' ')).toContain('-map_metadata -1')
      expect(args.join(' ')).toContain('-map_metadata:s -1')
      expect(args.join(' ')).toContain('-map_chapters -1')
      // only the file protocol; the formats are named, never probed; fixed file names
      expect(args.join(' ')).toContain('-protocol_whitelist file')
      expect(args).toContain(AvSanitizing.INPUT_FILE)
      expect(args[args.length - 1]).toBe(AvSanitizing.OUTPUT_FILE)
      expect(args.join(' ')).toContain(`-f ${AvSanitizing.FORMATS[type]?.input ?? ''}`)
    }
  })

  it('never carry a character that a shell or a protocol would read, and do not depend on the file', () => {
    for (const type of Object.keys(AvSanitizing.FORMATS)) {
      for (const argument of [...cleanArgs(type), ...probeArgs(type, AvSanitizing.INPUT_FILE)]) {
        expect(argument).toMatch(/^[-+:\w.?/]+$/)
        expect(argument).not.toMatch(/^(concat|http|tcp|udp|pipe|subfile|data)/i)
      }
    }
  })

  it('cut the cover of audio and keep the video streams of video', () => {
    expect(cleanArgs('audio/mpeg')).toContain('-vn')
    expect(cleanArgs('audio/mp4')).toContain('-vn')
    expect(cleanArgs('video/mp4')).not.toContain('-vn')
    expect(cleanArgs('audio/mpeg')).toEqual(expect.arrayContaining(['-write_id3v2', '0']))
    // the Xing header stays: without it the length of a VBR file is a guess
    expect(cleanArgs('audio/mpeg')).not.toContain('-write_xing')
  })

  it('refuse a type that is not video or audio', () => {
    expect(() => cleanArgs('image/png')).toThrow()
    expect(() => probeArgs('application/pdf', 'x')).toThrow()
  })
})

describe('parseProbe', () => {
  it('reads streams, duration and tags', () => {
    const json = JSON.stringify({
      streams: [
        { codec_type: 'video', codec_name: 'h264', tags: { handler_name: 'VideoHandler' } },
        { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } }
      ],
      format: { duration: '1.5', tags: { location: '+1/' } }
    })
    expect(parseProbe(json)).toEqual({
      streams: [
        {
          type: 'video',
          codec: 'h264',
          attachedPicture: false,
          tags: { handler_name: 'VideoHandler' }
        },
        { type: 'video', codec: 'mjpeg', attachedPicture: true, tags: {} }
      ],
      durationSeconds: 1.5,
      formatTags: { location: '+1/' }
    })
  })

  it('answers null for anything that is not the output asked for', () => {
    expect(parseProbe('not json')).toBeNull()
    expect(parseProbe('{}')).toBeNull()
    expect(parseProbe(JSON.stringify({ streams: 'x', format: {} }))).toBeNull()
    expect(parseProbe(JSON.stringify({ streams: [], format: { tags: { a: 1 } } }))).toBeNull()
    const many = Array.from({ length: 65 }, () => ({ codec_type: 'audio' }))
    expect(parseProbe(JSON.stringify({ streams: many, format: {} }))).toBeNull()
  })

  it('has an unknown duration when the file does not say it', () => {
    const read = parseProbe(JSON.stringify({ streams: [], format: {} }))
    expect(Number.isNaN(read?.durationSeconds)).toBe(true)
  })
})

describe('carriesMetadata', () => {
  it('is false for a file with only what a muxer writes by itself', () => {
    const clean = probe({
      formatTags: { major_brand: 'isom', minor_version: '512', compatible_brands: 'isomiso2' },
      streams: [
        stream('video', 'h264', { tags: { handler_name: 'VideoHandler', language: 'und' } })
      ]
    })
    expect(carriesMetadata(clean, BODY)).toBe(false)
  })

  it.each([
    ['a location tag', { formatTags: { location: '+40.7-074.0/' } }],
    ['the Apple location', { formatTags: { 'com.apple.quicktime.location.ISO6709': '+1/' } }],
    ['a creation time', { formatTags: { creation_time: '2024-05-01T10:00:00Z' } }],
    ['a model', { formatTags: { model: 'PhoneX' } }],
    ['a key in capitals (ogg)', { formatTags: { ARTIST: 'Someone' } }],
    ['a stream tag', { streams: [stream('audio', 'aac', { tags: { creation_time: 'x' } })] }],
    [
      'a handler name that is not plain text',
      { streams: [stream('audio', 'aac', { tags: { handler_name: 'a\u0001b' } })] }
    ],
    [
      'a handler name that is too long',
      { streams: [stream('audio', 'aac', { tags: { handler_name: 'x'.repeat(65) } })] }
    ],
    [
      'a cover picture',
      { streams: [stream('audio', 'mp3'), stream('video', 'mjpeg', { attachedPicture: true })] }
    ],
    ['a data stream', { streams: [stream('video', 'h264'), stream('data', 'bin_data')] }]
  ])('is true for %s', (_name, over) => {
    expect(carriesMetadata(probe(over as Partial<AvProbe>), BODY)).toBe(true)
  })

  it('is true when the bytes name the source, whatever the tags say', () => {
    expect(carriesMetadata(probe(), Buffer.from('xx ISO6709 yy'))).toBe(true)
  })
})

describe('namesTheSource', () => {
  it('sees the long names and a tag at the very start', () => {
    expect(namesTheSource(Buffer.from('..com.apple.quicktime.make..', 'latin1'))).toBe(true)
    expect(namesTheSource(Buffer.from('..creation_time..'))).toBe(true)
    expect(namesTheSource(Buffer.from('ID3\u0004\0\0\0\0\0\u000arest', 'latin1'))).toBe(true)
  })

  it('does not take the empty ID3 header that the mp3 muxer writes for a tag', () => {
    expect(namesTheSource(Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb]))).toBe(
      false
    )
  })

  it('does not take an ID3 mark in the middle for a tag, nor a short chance match', () => {
    expect(namesTheSource(Buffer.from('rest ID3 rest'))).toBe(false)
    expect(namesTheSource(Buffer.from([0xa9, 0x78, 0x79, 0x7a, 0x6c, 0x6f, 0x63, 0x69]))).toBe(
      false
    )
  })
})

describe('verifyCleaned', () => {
  const out = Buffer.from('copy')

  it('accepts a copy with the same streams and length and nothing else', () => {
    expect(verifyCleaned(probe(), probe(), out)).toBeNull()
    // the length may move by the tolerance
    expect(verifyCleaned(probe(), probe({ durationSeconds: 10.2 }), out)).toBeNull()
  })

  it.each([
    ['an empty file', probe(), Buffer.alloc(0), 'empty'],
    ['a stream less', probe({ streams: [stream('video', 'h264')] }), out, 'streams_changed'],
    [
      'a stream more',
      probe({ streams: [stream('video', 'h264'), stream('audio', 'aac'), stream('audio', 'aac')] }),
      out,
      'streams_changed'
    ],
    [
      'another codec',
      probe({ streams: [stream('video', 'hevc'), stream('audio', 'aac')] }),
      out,
      'streams_changed'
    ],
    [
      'another order',
      probe({ streams: [stream('audio', 'aac'), stream('video', 'h264')] }),
      out,
      'streams_changed'
    ],
    [
      'a cover that came along',
      probe({
        streams: [
          stream('video', 'h264'),
          stream('audio', 'aac'),
          stream('video', 'mjpeg', { attachedPicture: true })
        ]
      }),
      out,
      'cover_kept'
    ],
    [
      'a data stream that came along',
      probe({ streams: [stream('video', 'h264'), stream('audio', 'aac'), stream('data', 'x')] }),
      out,
      'data_kept'
    ],
    ['a shorter clip', probe({ durationSeconds: 5 }), out, 'duration_changed'],
    ['a longer clip', probe({ durationSeconds: 11 }), out, 'duration_changed'],
    ['an unknown length', probe({ durationSeconds: Number.NaN }), out, 'duration_unknown'],
    ['a tag that stayed', probe({ formatTags: { location: '+1/' } }), out, 'tags_kept'],
    ['a name in the bytes', probe(), Buffer.from('xxISO6709'), 'source_named']
  ])('refuses %s', (_name, after, body, reason) => {
    expect(verifyCleaned(probe(), after, body)).toBe(reason)
  })

  it('accepts the copy when the original has its audio before its video (the copy writes video first)', () => {
    const original = probe({ streams: [stream('audio', 'aac'), stream('video', 'h264')] })
    expect(verifyCleaned(original, probe(), out)).toBeNull()
    expect(
      verifyCleaned(
        original,
        probe({ streams: [stream('audio', 'aac'), stream('video', 'h264')] }),
        out
      )
    ).toBe('streams_changed')
  })

  it('refuses when the original had no video or audio stream to compare with', () => {
    expect(verifyCleaned(probe({ streams: [] }), probe({ streams: [] }), out)).toBe(
      'no_media_stream'
    )
  })

  it('does not count the cover of the original as a stream the copy must keep', () => {
    const original = probe({
      streams: [stream('audio', 'mp3'), stream('video', 'mjpeg', { attachedPicture: true })]
    })
    expect(verifyCleaned(original, probe({ streams: [stream('audio', 'mp3')] }), out)).toBeNull()
  })

  it('takes the tolerance as a ratio for a long clip', () => {
    const long = probe({ durationSeconds: 1000 })
    expect(verifyCleaned(long, probe({ durationSeconds: 1009 }), out)).toBeNull()
    expect(verifyCleaned(long, probe({ durationSeconds: 1011 }), out)).toBe('duration_changed')
  })
})
