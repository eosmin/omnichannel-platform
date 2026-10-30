import { previewOf } from './preview'

const message = (over: Partial<NonNullable<Parameters<typeof previewOf>[0]>>) => ({
  id: 'm1',
  authorType: 'customer',
  type: 'TEXT',
  contentPreview: 'hola',
  createdAt: '2026-10-30T10:00:00.000Z',
  ...over
})

describe('previewOf', () => {
  it('is empty when nothing was said', () => {
    expect(previewOf(null)).toEqual({ kind: 'empty' })
  })

  it('shows the text, and who wrote it', () => {
    expect(previewOf(message({ contentPreview: '  hola  ' }))).toEqual({
      kind: 'text',
      text: 'hola',
      byAgent: false,
      isNote: false
    })
    expect(previewOf(message({ authorType: 'agent' }))).toMatchObject({ byAgent: true })
  })

  it('marks a note', () => {
    expect(previewOf(message({ type: 'INTERNAL_NOTE' }))).toMatchObject({ isNote: true })
  })

  it('names a message with no text by its type', () => {
    expect(previewOf(message({ type: 'IMAGE', contentPreview: null }))).toEqual({
      kind: 'type',
      type: 'IMAGE',
      byAgent: false
    })
  })

  it('names a type it does not know in a generic way', () => {
    expect(previewOf(message({ type: 'HOLOGRAM', contentPreview: '' }))).toMatchObject({
      kind: 'type',
      type: 'unknown'
    })
  })
})
