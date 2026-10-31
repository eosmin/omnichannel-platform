import { type HandlerEntry, insertByPriority, isMacPlatformName, runEntries } from './dispatch'

const entry = (priority: number, answer: boolean | void, calls: string[], name: string) =>
  ({
    priority,
    handler: {
      current: () => {
        calls.push(name)
        return answer
      }
    }
  }) satisfies HandlerEntry<string>

describe('runEntries', () => {
  it('stops at the first handler that takes the key', () => {
    const calls: string[] = []
    const entries = [entry(3, undefined, calls, 'bar'), entry(1, undefined, calls, 'open')]
    expect(runEntries(entries, 'a')).toBe(true)
    expect(calls).toEqual(['bar'])
  })

  it('falls through to the next handler when one answers false', () => {
    const calls: string[] = []
    const entries = [entry(2, false, calls, 'row'), entry(1, undefined, calls, 'open')]
    expect(runEntries(entries, 'a')).toBe(true)
    expect(calls).toEqual(['row', 'open'])
  })

  it('says nothing took the key when every handler passed', () => {
    const calls: string[] = []
    expect(runEntries([entry(1, false, calls, 'row')], 'a')).toBe(false)
    expect(runEntries([], 'a')).toBe(false)
  })

  it('counts a true answer as taking the key', () => {
    expect(runEntries([entry(1, true, [], 'x')], 'a')).toBe(true)
  })
})

describe('insertByPriority', () => {
  it('puts the highest priority first and keeps registration order among equals', () => {
    const first = { priority: 1, id: 'first' }
    const second = { priority: 1, id: 'second' }
    const top = { priority: 3, id: 'top' }
    const result = insertByPriority(insertByPriority(insertByPriority([], first), second), top)
    expect(result.map(item => item.id)).toEqual(['top', 'first', 'second'])
  })
})

describe('isMacPlatformName', () => {
  it('reads the new platform field first and the old one after', () => {
    expect(isMacPlatformName({ userAgentData: { platform: 'macOS' } })).toBe(true)
    expect(isMacPlatformName({ platform: 'MacIntel' })).toBe(true)
    expect(isMacPlatformName({ platform: 'iPad' })).toBe(true)
    expect(isMacPlatformName({ platform: 'Win32' })).toBe(false)
    expect(
      isMacPlatformName({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })
    ).toBe(false)
    expect(isMacPlatformName({})).toBe(false)
  })
})
