import { inboundMediaId } from './inbound-media-id'

const MESSAGE = '8f1c7a52-3b1e-4a56-9a44-0d2f6a1b7c10'

describe('inboundMediaId', () => {
  it('is a uuid', () => {
    expect(inboundMediaId(MESSAGE, 0)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })

  it('is the same for the same message and place', () => {
    expect(inboundMediaId(MESSAGE, 2)).toBe(inboundMediaId(MESSAGE, 2))
  })

  it('differs by place and by message', () => {
    expect(inboundMediaId(MESSAGE, 0)).not.toBe(inboundMediaId(MESSAGE, 1))
    expect(inboundMediaId(MESSAGE, 0)).not.toBe(
      inboundMediaId('1f1c7a52-3b1e-4a56-9a44-0d2f6a1b7c10', 0)
    )
  })
})
