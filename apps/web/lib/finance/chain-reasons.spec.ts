import { knownChainReason, KnownChainReasons } from './chain-reasons'

describe('knownChainReason', () => {
  it('knows the five reasons the api names and nothing else', () => {
    for (const reason of KnownChainReasons) expect(knownChainReason(reason)).toBe(reason)
    expect(knownChainReason('something_new')).toBeNull()
    expect(knownChainReason('')).toBeNull()
  })
})
