import { albumCaptionLinesOf, fileCaptionOf } from './file-caption'

const file = (overrides: Partial<Parameters<typeof fileCaptionOf>[0]> = {}) => ({
  position: 1,
  caption: 'Second',
  ...overrides
})

describe('fileCaptionOf', () => {
  it('draws the text under a file that is not the first', () => {
    expect(fileCaptionOf(file())).toBe('Second')
  })

  it('leaves the first file to the text of the message', () => {
    expect(fileCaptionOf(file({ position: 0 }))).toBeNull()
  })

  it('draws nothing for a file of the customer or a blank text', () => {
    expect(fileCaptionOf(file({ position: null }))).toBeNull()
    expect(fileCaptionOf(file({ caption: '  ' }))).toBeNull()
    expect(fileCaptionOf(file({ caption: null }))).toBeNull()
  })
})

describe('albumCaptionLinesOf', () => {
  const album = (...captions: (string | null)[]) =>
    captions.map((caption, position) => ({
      id: `f${position}`,
      position,
      caption
    }))
  const lead = { hasText: true, hasNotice: false }

  it('lists the texts in the order of the files, the first file first, numbered by its place', () => {
    // Given in the wrong order on purpose: the order is the place of the file, not the order of the list
    const lines = albumCaptionLinesOf(album('Uno', 'Dos', 'Tres').toReversed(), lead)
    expect(lines.map(line => [line.number, line.file.id, line.isLead])).toEqual([
      [1, 'f0', true],
      [2, 'f1', false],
      [3, 'f2', false]
    ])
  })

  it('has no line for a file without a text, and keeps the number of the others', () => {
    const lines = albumCaptionLinesOf(album('Uno', null, 'Tres'), lead)
    expect(lines.map(line => line.number)).toEqual([1, 3])
  })

  it('has no line for the first file when the message has no text and no notice', () => {
    const lines = albumCaptionLinesOf(album(null, 'Dos', 'Tres'), {
      hasText: false,
      hasNotice: false
    })
    expect(lines.map(line => line.number)).toEqual([2, 3])
  })

  it('keeps the first file when only its notice has something to say', () => {
    const lines = albumCaptionLinesOf(album(null, 'Dos'), { hasText: false, hasNotice: true })
    expect(lines.map(line => line.number)).toEqual([1, 2])
  })

  it('draws nothing when fewer than two files have something to say', () => {
    expect(albumCaptionLinesOf(album(null, null), { hasText: false, hasNotice: false })).toEqual([])
    expect(albumCaptionLinesOf(album('Uno', null, null), lead)).toEqual([])
    expect(albumCaptionLinesOf(album(null, 'Dos'), { hasText: false, hasNotice: false })).toEqual(
      []
    )
  })

  it('draws nothing when the places are not exactly 0 to n-1, each once', () => {
    const files = album('Uno', 'Dos', 'Tres')
    expect(albumCaptionLinesOf(files.slice(1), lead)).toEqual([])
    expect(
      albumCaptionLinesOf(
        files.map(file => ({ ...file, position: 1 })),
        lead
      )
    ).toEqual([])
    expect(
      albumCaptionLinesOf(
        files.map(file => ({ ...file, position: file.position + 1 })),
        lead
      )
    ).toEqual([])
  })

  it('leaves alone an album of the customer, whose files have no place', () => {
    const files = album('Uno', 'Dos').map(file => ({ ...file, position: null }))
    expect(albumCaptionLinesOf(files, lead)).toEqual([])
  })
})
