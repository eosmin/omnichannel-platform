import { keptCodeFilter, keptCodeOf, keptEventPayload } from './kept-event'

describe('the payload of a kept carrier event', () => {
  it('gives back the code it was written with', () => {
    expect(keptCodeOf(keptEventPayload('16:115', { plainCode: '16', reasonCode: '115' }))).toEqual({
      plainCode: '16',
      reasonCode: '115'
    })
    expect(keptCodeOf(keptEventPayload('zz', { plainCode: 'zz' }))).toEqual({ plainCode: 'zz' })
  })

  it('leaves a line alone whose payload this layer did not write', () => {
    for (const payload of [null, undefined, 'x', 7, [], {}, { plainCode: '' }, { plainCode: 4 }]) {
      expect(keptCodeOf(payload)).toBeNull()
    }
    expect(keptCodeOf({ plainCode: 'a', reasonCode: '' })).toEqual({ plainCode: 'a' })
  })

  it('filters on the code and on its reasons through the same key the writer uses', () => {
    const written = keptEventPayload('16:115', { plainCode: '16', reasonCode: '115' })
    const [exact, reasons] = keptCodeFilter('16')
    expect(Object.keys(written)).toContain(exact?.payload.path[0])
    expect(exact?.payload).toMatchObject({ equals: '16' })
    expect(reasons?.payload).toMatchObject({ string_starts_with: '16:' })
  })
})
