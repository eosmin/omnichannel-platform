import { EventContextNotNeeded } from './event-context-marker'

describe('EventContextNotNeeded', () => {
  const apply = (reason: string): (() => void) => {
    const descriptor: TypedPropertyDescriptor<() => Promise<void>> = {
      value: () => Promise.resolve()
    }
    return () => EventContextNotNeeded(reason)({}, 'handler', descriptor)
  }

  it('does not change the handler', () => {
    const original = () => Promise.resolve()
    const descriptor: TypedPropertyDescriptor<() => Promise<void>> = { value: original }
    EventContextNotNeeded('only drops a Redis key')({}, 'handler', descriptor)
    expect(descriptor.value).toBe(original)
  })

  it('refuses an empty reason, so every exemption says why', () => {
    expect(apply('')).toThrow('reason')
    expect(apply('   ')).toThrow('reason')
  })
})
