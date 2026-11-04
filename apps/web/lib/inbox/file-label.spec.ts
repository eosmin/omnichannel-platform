import { UNNAMED_FILE_NAME } from '@platform/core/storage'

import { displayFileNameOf } from './file-label'

describe('displayFileNameOf', () => {
  it('keeps a name the file came with', () => {
    expect(displayFileNameOf('invoice.pdf', 'DOCUMENT')).toEqual({
      kind: 'name',
      name: 'invoice.pdf'
    })
  })

  it.each(['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT'])(
    'asks for the label of the kind when %s has no name',
    type => {
      expect(displayFileNameOf(UNNAMED_FILE_NAME, type)).toEqual({ kind: 'label', type })
    }
  )

  it('treats a blank name as no name', () => {
    expect(displayFileNameOf('   ', 'AUDIO')).toEqual({ kind: 'label', type: 'AUDIO' })
  })

  it('has no label for a kind it does not know, and keeps the placeholder', () => {
    expect(displayFileNameOf(UNNAMED_FILE_NAME, 'SOMETHING')).toEqual({
      kind: 'name',
      name: UNNAMED_FILE_NAME
    })
  })
})
