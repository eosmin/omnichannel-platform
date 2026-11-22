import { PDFDocument } from 'pdf-lib'

import { replyFor } from './document-thread.reply'

const PDF = 'application/pdf'

// What the thread answers for what it receives: the real cleaner, with the types the sweep and the scan hand it
describe('replyFor (the answer of the document thread)', () => {
  async function pdfWithAuthor(): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    doc.addPage([100, 100])
    doc.setAuthor('Jane Q. Author')
    return new Uint8Array(await doc.save({ useObjectStreams: false }))
  }

  it('answers with the cleaned bytes', async () => {
    const reply = await replyFor({ input: await pdfWithAuthor(), contentType: PDF, maxBytes: 1e7 })
    expect(reply.kind).toBe('sanitized')
    const body = reply.kind === 'sanitized' ? Buffer.from(reply.body) : Buffer.alloc(0)
    expect(body.includes('Jane Q. Author')).toBe(false)
  })

  it('answers that a damaged file cannot be cleaned, without its text', async () => {
    const reply = await replyFor({
      input: new Uint8Array(Buffer.from('not a pdf at all')),
      contentType: PDF,
      maxBytes: 1e7
    })
    expect(reply).toEqual({ kind: 'untouched', why: 'not_cleanable' })
  })

  it('answers for a type it does not take', async () => {
    const reply = await replyFor({
      input: new Uint8Array(1),
      contentType: 'text/plain',
      maxBytes: 1e7
    })
    expect(reply).toEqual({ kind: 'untouched', why: 'type' })
  })
})
