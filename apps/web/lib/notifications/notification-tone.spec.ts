import { NotificationTone, playTone, type ToneContext } from './notification-tone'

function fakeContext(
  state: AudioContextState,
  resume: () => Promise<void> = () => Promise.resolve()
) {
  const frequency = { value: 0 }
  const gainParam = { setValueAtTime: jest.fn(), linearRampToValueAtTime: jest.fn() }
  const gain = { gain: gainParam, connect: jest.fn((node: unknown) => node), disconnect: jest.fn() }
  const oscillator = {
    frequency,
    connect: jest.fn(() => gain),
    start: jest.fn(),
    stop: jest.fn(),
    disconnect: jest.fn(),
    onended: null as (() => void) | null
  }
  const context = {
    state,
    currentTime: 10,
    destination: {},
    resume: jest.fn(resume),
    createOscillator: () => oscillator,
    createGain: () => gain
  }
  return {
    context: context as unknown as ToneContext,
    oscillator,
    gain,
    gainParam,
    frequency,
    resume: context.resume
  }
}

describe('playTone', () => {
  it('plays one short tone with an attack and a release on a running context', () => {
    const { context, oscillator, frequency, gainParam } = fakeContext('running')

    expect(playTone(context)).toBe(10)

    expect(frequency.value).toBe(NotificationTone.FREQUENCY_HZ)
    expect(oscillator.start).toHaveBeenCalledWith(10)
    expect(oscillator.stop).toHaveBeenCalledWith(10 + NotificationTone.DURATION_S)
    expect(gainParam.setValueAtTime).toHaveBeenCalledWith(0, 10)
    expect(gainParam.linearRampToValueAtTime).toHaveBeenNthCalledWith(
      1,
      NotificationTone.PEAK_GAIN,
      10 + NotificationTone.ATTACK_S
    )
    expect(gainParam.linearRampToValueAtTime).toHaveBeenNthCalledWith(
      2,
      0,
      10 + NotificationTone.DURATION_S
    )
  })

  it('lets go of its nodes when the tone ends', () => {
    const { context, oscillator, gain } = fakeContext('running')
    playTone(context)

    oscillator.onended?.()

    expect(oscillator.disconnect).toHaveBeenCalled()
    expect(gain.disconnect).toHaveBeenCalled()
  })

  it('skips, and does not wait, while the page is not allowed to make sound', () => {
    // The browser holds this promise until the next click: nothing may wait for it
    const { context, oscillator, resume } = fakeContext(
      'suspended',
      () => new Promise(() => undefined)
    )

    expect(playTone(context)).toBeNull()
    expect(resume).toHaveBeenCalledTimes(1)
    expect(oscillator.start).not.toHaveBeenCalled()
  })

  it('survives a resume that is refused', () => {
    const { context } = fakeContext('suspended', () => Promise.reject(new Error('refused')))

    expect(playTone(context)).toBeNull()
  })

  it('is skipped when the context is closed', () => {
    const { context, oscillator } = fakeContext('closed')

    expect(playTone(context)).toBeNull()
    expect(oscillator.start).not.toHaveBeenCalled()
  })

  it('drops the rest of a burst', () => {
    const { context, oscillator } = fakeContext('running')

    expect(playTone(context, 10 - NotificationTone.MIN_GAP_S / 2)).toBeNull()
    expect(playTone(context, 10 - NotificationTone.MIN_GAP_S)).toBe(10)
    expect(oscillator.start).toHaveBeenCalledTimes(1)
  })
})
