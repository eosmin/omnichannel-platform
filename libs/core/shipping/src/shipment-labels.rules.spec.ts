import { hasPdfSignature } from './shipment-labels.rules'

describe('what a label may be', () => {
  it('begins like a PDF', () => {
    expect(hasPdfSignature(new TextEncoder().encode('%PDF-1.4 body'))).toBe(true)
  })

  it('is not a page of HTML, a picture or an empty file', () => {
    expect(hasPdfSignature(new TextEncoder().encode('<html></html>'))).toBe(false)
    expect(hasPdfSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false)
    expect(hasPdfSignature(new Uint8Array())).toBe(false)
    expect(hasPdfSignature(new TextEncoder().encode('%PDF'))).toBe(false)
  })
})
