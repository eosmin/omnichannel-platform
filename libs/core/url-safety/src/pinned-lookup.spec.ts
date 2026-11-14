import { pinnedLookup } from './pinned-lookup'

describe('pinnedLookup', () => {
  it('answers with the vetted address whatever the name, in both forms node asks', () => {
    const lookup = pinnedLookup(['8.8.8.8', '2001:4860:4860::8888']) as unknown as (
      host: string,
      options: { all?: boolean },
      callback: (...args: unknown[]) => void
    ) => void
    const single = jest.fn()
    lookup('anything.example', {}, single)
    expect(single).toHaveBeenCalledWith(null, '8.8.8.8', 4)
    const all = jest.fn()
    lookup('anything.example', { all: true }, all)
    expect(all).toHaveBeenCalledWith(null, [
      { address: '8.8.8.8', family: 4 },
      { address: '2001:4860:4860::8888', family: 6 }
    ])
  })
})
