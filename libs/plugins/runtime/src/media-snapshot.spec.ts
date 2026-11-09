import { ChannelCapability, type ChannelPlugin } from '@platform/plugins/sdk'

import { snapshotChannelMedia } from './media-snapshot'

const MB = 1024 * 1024

function media(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    maxFilesPerMessage: 1,
    kinds: {
      image: { types: ['image/jpeg', 'image/png'], maxBytes: 5 * MB },
      document: { types: null, maxBytes: 25 * MB }
    },
    ...overrides
  }
}

const capabilities = [ChannelCapability.TEXT, ChannelCapability.IMAGE, ChannelCapability.DOCUMENT]

function plugin(declared: unknown, sendAlbum: unknown = undefined): ChannelPlugin {
  const hasAlbum =
    typeof declared === 'object' &&
    declared !== null &&
    'album' in declared &&
    declared.album !== undefined
  // A plugin that declares an album has the method; a test that wants it missing passes `null`
  const method =
    sendAlbum === null ? undefined : (sendAlbum ?? (hasAlbum ? () => undefined : undefined))
  return { id: 'messenger', media: declared, sendAlbum: method } as unknown as ChannelPlugin
}

function refuses(declared: unknown, caps: readonly string[] = capabilities): string | undefined {
  try {
    snapshotChannelMedia(plugin(declared), 'messenger', caps as never)
  } catch (error) {
    return (error as { message?: string }).message
  }
  return undefined
}

describe('snapshotChannelMedia', () => {
  it('is null for a channel that takes no file and declares none', () => {
    expect(snapshotChannelMedia(plugin(undefined), 'web', [ChannelCapability.TEXT])).toBeNull()
  })

  it('keeps what a well formed declaration says, for exactly the kinds of the capabilities', () => {
    const snapshot = snapshotChannelMedia(plugin(media()), 'messenger', capabilities)
    expect(snapshot?.maxFilesPerMessage).toBe(1)
    expect(snapshot?.kinds.image).toEqual({ types: ['image/jpeg', 'image/png'], maxBytes: 5 * MB })
    expect(snapshot?.kinds.document).toEqual({ types: null, maxBytes: 25 * MB })
    expect(snapshot?.kinds.video).toBeUndefined()
  })

  it('copies the declaration deeply and freezes it, so a plugin that changes it later grows nothing', () => {
    const declared = media()
    const kinds = declared['kinds'] as Record<string, { types: string[]; maxBytes: number }>
    const snapshot = snapshotChannelMedia(plugin(declared), 'messenger', capabilities)

    kinds['image']?.types.push('image/svg+xml')
    if (kinds['image']) kinds['image'].maxBytes = 99 * MB
    declared['maxFilesPerMessage'] = 30

    expect(snapshot?.kinds.image?.types).toEqual(['image/jpeg', 'image/png'])
    expect(snapshot?.kinds.image?.maxBytes).toBe(5 * MB)
    expect(snapshot?.maxFilesPerMessage).toBe(1)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot?.kinds)).toBe(true)
    expect(Object.isFrozen(snapshot?.kinds.image)).toBe(true)
    expect(Object.isFrozen(snapshot?.kinds.image?.types)).toBe(true)
  })

  it('refuses a channel that declares a kind of file as a capability and no rule at all', () => {
    expect(refuses(undefined)).toContain('invalid media')
  })

  it('refuses a rule for a kind the channel does not declare, and a declared kind with no rule', () => {
    expect(
      refuses(
        media({
          kinds: { image: { types: null, maxBytes: MB }, video: { types: null, maxBytes: MB } }
        })
      )
    ).toBeDefined()
    expect(refuses(media({ kinds: { image: { types: null, maxBytes: MB } } }))).toBeDefined()
  })

  it.each([
    ['a block that is not an object', 'x'],
    ['an array', []],
    ['no count of files', media({ maxFilesPerMessage: undefined })],
    ['zero files', media({ maxFilesPerMessage: 0 })],
    ['more files than the platform allows', media({ maxFilesPerMessage: 31 })],
    ['a fraction of files', media({ maxFilesPerMessage: 1.5 })],
    ['kinds that are an array', media({ kinds: [] })],
    [
      'a size of zero',
      media({
        kinds: { image: { types: null, maxBytes: 0 }, document: { types: null, maxBytes: MB } }
      })
    ],
    [
      'a size over what the platform allows',
      media({
        kinds: {
          image: { types: null, maxBytes: 101 * MB },
          document: { types: null, maxBytes: MB }
        }
      })
    ],
    [
      'a size that is not a whole number',
      media({
        kinds: { image: { types: null, maxBytes: 1.5 }, document: { types: null, maxBytes: MB } }
      })
    ],
    [
      'an empty list of types',
      media({
        kinds: { image: { types: [], maxBytes: MB }, document: { types: null, maxBytes: MB } }
      })
    ],
    [
      'a type that is not a type',
      media({
        kinds: {
          image: { types: ['image'], maxBytes: MB },
          document: { types: null, maxBytes: MB }
        }
      })
    ],
    [
      'a type with a line break',
      media({
        kinds: {
          image: { types: ['image/png\r\nx'], maxBytes: MB },
          document: { types: null, maxBytes: MB }
        }
      })
    ],
    [
      'a type in capitals',
      media({
        kinds: {
          image: { types: ['IMAGE/PNG'], maxBytes: MB },
          document: { types: null, maxBytes: MB }
        }
      })
    ],
    [
      'a repeated type',
      media({
        kinds: {
          image: { types: ['image/png', 'image/png'], maxBytes: MB },
          document: { types: null, maxBytes: MB }
        }
      })
    ],
    [
      'a rule that is not an object',
      media({ kinds: { image: 'x', document: { types: null, maxBytes: MB } } })
    ]
  ])('refuses %s', (_name, declared) => {
    expect(refuses(declared)).toContain('invalid media')
  })

  it('refuses a list of types with a hole, which `every` would skip', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = ['image/png', , 'image/jpeg']
    expect(
      refuses(
        media({
          kinds: { image: { types: sparse, maxBytes: MB }, document: { types: null, maxBytes: MB } }
        })
      )
    ).toContain('invalid media')
  })

  it('reads a list of types once: one that answers differently each time keeps what the copy held', () => {
    let reads = 0
    const types = new Proxy(['image/png'], {
      get(target, key, receiver): unknown {
        if (key === 'length') reads += 1
        return Reflect.get(target, key, receiver)
      }
    })
    const snapshot = snapshotChannelMedia(
      plugin(
        media({
          kinds: { image: { types, maxBytes: MB }, document: { types: null, maxBytes: MB } }
        })
      ),
      'messenger',
      capabilities
    )
    expect(snapshot?.kinds.image?.types).toEqual(['image/png'])
    expect(reads).toBeLessThanOrEqual(3)
  })

  describe('album', () => {
    it('keeps a well formed album, as a frozen copy', () => {
      const album = { kinds: ['image'], maxFiles: 10 }
      const snapshot = snapshotChannelMedia(
        plugin(media({ maxFilesPerMessage: 10, album })),
        'messenger',
        capabilities
      )
      expect(snapshot?.album).toEqual({ kinds: ['image'], maxFiles: 10 })
      album.kinds.push('document')
      album.maxFiles = 30
      expect(snapshot?.album).toEqual({ kinds: ['image'], maxFiles: 10 })
      expect(Object.isFrozen(snapshot?.album)).toBe(true)
      expect(Object.isFrozen(snapshot?.album?.kinds)).toBe(true)
    })

    it('refuses an album with no sendAlbum, and a sendAlbum with no album', () => {
      const album = { kinds: ['image'], maxFiles: 10 }
      expect(() =>
        snapshotChannelMedia(
          plugin(media({ maxFilesPerMessage: 10, album }), null),
          'messenger',
          capabilities
        )
      ).toThrow('invalid media')
      expect(() =>
        snapshotChannelMedia(
          plugin(media(), () => undefined),
          'messenger',
          capabilities
        )
      ).toThrow('invalid media')
    })

    it('has no album when the plugin declares none', () => {
      expect(
        snapshotChannelMedia(plugin(media()), 'messenger', capabilities)?.album
      ).toBeUndefined()
    })

    it.each([
      ['an album that is not an object', 'x'],
      ['an album with no kinds', { kinds: [], maxFiles: 10 }],
      ['an album of a kind the channel does not declare', { kinds: ['video'], maxFiles: 10 }],
      ['an album of a kind that does not exist', { kinds: ['sticker'], maxFiles: 10 }],
      ['an album that repeats a kind', { kinds: ['image', 'image'], maxFiles: 10 }],
      ['an album of one file', { kinds: ['image'], maxFiles: 1 }],
      ['an album above the limit of files', { kinds: ['image'], maxFiles: 31 }],
      ['an album larger than a message may hold', { kinds: ['image'], maxFiles: 11 }],
      ['an album with a fractional size', { kinds: ['image'], maxFiles: 2.5 }],
      ['an album with kinds that are not a list', { kinds: 'image', maxFiles: 10 }]
    ])('refuses %s', (_name, album) => {
      expect(refuses(media({ maxFilesPerMessage: 10, album }))).toContain('invalid media')
    })
  })

  it('refuses a block for a channel that takes no file: an empty one would read as "takes files"', () => {
    expect(refuses(media({ kinds: {} }), [ChannelCapability.TEXT])).toContain('invalid media')
  })

  it('prints nothing of what the plugin declared', () => {
    const message = refuses(
      media({
        kinds: {
          image: { types: ['SECRET-VALUE'], maxBytes: MB },
          document: { types: null, maxBytes: MB }
        }
      })
    )
    expect(message).not.toContain('SECRET-VALUE')
  })
})
