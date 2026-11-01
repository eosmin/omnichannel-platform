import type { GalleryPageView } from '@platform/api-client'

import { countsOfPages, isViewable } from './gallery-view'

const counts = { all: 3, image: 2, video: 1, audio: 0, document: 0 }
const page = (withCounts: boolean): GalleryPageView => ({
  data: [],
  nextCursor: null,
  hasMore: false,
  counts: withCounts ? counts : null
})

describe('countsOfPages', () => {
  it('reads the counts of the first page, whatever the later pages carry', () => {
    expect(countsOfPages([page(true), page(false)])).toEqual(counts)
  })

  it('has none before the first page arrives', () => {
    expect(countsOfPages([])).toBeNull()
  })
})

describe('isViewable', () => {
  it.each([
    ['image', true],
    ['video', true],
    ['audio', false],
    ['document', false],
    [null, false]
  ])('%s -> %s', (type, expected) => {
    expect(isViewable(type)).toBe(expected)
  })
})
