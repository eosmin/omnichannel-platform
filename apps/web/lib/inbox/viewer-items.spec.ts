import { MediaStatus } from '@platform/core/domain'

import { stepViewerKey, viewerItemsOf, viewerItemsOfRun } from './viewer-items'

const file = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  filename: `${id}.png`,
  contentType: 'image/png',
  status: MediaStatus.CLEAN,
  position: null as number | null,
  caption: null as string | null,
  ...over
})

describe('viewerItemsOf', () => {
  it('lists the pictures of the message in their order, with the text under each', () => {
    const items = viewerItemsOf(
      [
        file('b', { position: 1, caption: '  Dos  ' }),
        file('a', { position: 0, caption: 'Uno' }),
        file('c', { position: 2 })
      ],
      'IMAGE'
    )

    expect(items).toEqual([
      { key: 'a', mediaId: 'a', filename: 'a.png', caption: 'Uno', number: 1 },
      { key: 'b', mediaId: 'b', filename: 'b.png', caption: 'Dos', number: 2 },
      { key: 'c', mediaId: 'c', filename: 'c.png', caption: null, number: 3 }
    ])
  })

  it('leaves out what the viewer does not walk: videos, documents, and pictures not yet clean', () => {
    const items = viewerItemsOf(
      [
        file('a'),
        file('v', { contentType: 'video/mp4' }),
        file('d', { contentType: 'application/pdf' }),
        file('p', { status: MediaStatus.PENDING }),
        file('i', { status: MediaStatus.INFECTED })
      ],
      'IMAGE'
    )

    expect(items.map(item => item.key)).toEqual(['a'])
  })

  it('keeps the order given for files with no place (a customer album)', () => {
    expect(viewerItemsOf([file('x'), file('y')], 'IMAGE').map(item => item.key)).toEqual(['x', 'y'])
  })

  it('numbers each picture by its place in the message, the same number its thumbnail wears', () => {
    // A video at place 1 is not walked, and the pictures keep the numbers of the grid
    const items = viewerItemsOf(
      [
        file('a', { position: 0 }),
        file('v', { position: 1, contentType: 'video/mp4' }),
        file('c', { position: 2 }),
        file('d', { position: 3 })
      ],
      'IMAGE'
    )

    expect(items.map(item => [item.key, item.number])).toEqual([
      ['a', 1],
      ['c', 3],
      ['d', 4]
    ])
  })

  it('numbers by the order given when the files have no place', () => {
    expect(viewerItemsOf([file('x'), file('y')], 'IMAGE').map(item => item.number)).toEqual([1, 2])
  })

  it('treats a blank text as none', () => {
    expect(viewerItemsOf([file('a', { caption: '   ' })], 'IMAGE')[0]?.caption).toBeNull()
  })
})

describe('stepViewerKey', () => {
  const items = ['a', 'b', 'c'].map((key, at) => ({
    key,
    mediaId: key,
    filename: key,
    caption: null,
    number: at + 1
  }))

  it('walks forward and back, and comes round at the ends', () => {
    expect(stepViewerKey(items, 'a', 1)).toBe('b')
    expect(stepViewerKey(items, 'c', 1)).toBe('a')
    expect(stepViewerKey(items, 'a', -1)).toBe('c')
    expect(stepViewerKey(items, 'b', -1)).toBe('a')
  })

  it('stays on the one picture when it is alone, and gives null when the open one left the list (the viewer closes)', () => {
    expect(stepViewerKey(items.slice(0, 1), 'a', 1)).toBe('a')
    expect(stepViewerKey(items, 'zzz', 1)).toBeNull()
    expect(stepViewerKey([], 'a', 1)).toBeNull()
  })
})

describe('viewerItemsOfRun', () => {
  const message = (id: string, files: ReturnType<typeof file>[]) => ({
    id,
    type: 'IMAGE',
    media: files
  })

  it('takes the picture of each message of the block, keyed by the message', () => {
    const items = viewerItemsOfRun([
      message('m1', [file('a')]),
      message('m2', [file('b')]),
      message('m3', [file('c')])
    ])

    expect(items.map(item => [item.key, item.mediaId, item.number])).toEqual([
      ['m1', 'a', 1],
      ['m2', 'b', 2],
      ['m3', 'c', 3]
    ])
  })

  it('leaves out a picture that is not clean: the arrows would land on a file with no links', () => {
    const items = viewerItemsOfRun([
      message('m1', [file('a')]),
      message('m2', [file('b', { status: MediaStatus.INFECTED })]),
      message('m3', [file('c', { status: MediaStatus.PENDING })]),
      message('m4', [file('d')])
    ])

    expect(items.map(item => item.key)).toEqual(['m1', 'm4'])
    // The number is the one of the thumbnail in the block
    expect(items.map(item => item.number)).toEqual([1, 4])
  })
})
