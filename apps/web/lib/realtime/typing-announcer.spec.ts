import { TypingTiming } from '@platform/core/realtime'

import { TypingAnnouncer } from './typing-announcer'

describe('TypingAnnouncer', () => {
  let at = 0
  let sendStart: jest.Mock
  let sendStop: jest.Mock
  let announcer: TypingAnnouncer

  beforeEach(() => {
    jest.useFakeTimers()
    at = 1_000_000
    sendStart = jest.fn(() => true)
    sendStop = jest.fn()
    announcer = new TypingAnnouncer({ sendStart, sendStop, now: () => at })
  })

  afterEach(() => jest.useRealTimers())

  it('sends one start for a burst of keys', () => {
    announcer.type()
    at += 500
    announcer.type()
    announcer.type()
    expect(sendStart).toHaveBeenCalledTimes(1)
  })

  it('repeats the start after the gap while keys keep coming', () => {
    announcer.type()
    at += TypingTiming.AGENT_START_GAP_MS
    announcer.type()
    expect(sendStart).toHaveBeenCalledTimes(2)
  })

  it('stops after the agent is idle', () => {
    announcer.type()
    jest.advanceTimersByTime(TypingTiming.AGENT_IDLE_STOP_MS)
    expect(sendStop).toHaveBeenCalledTimes(1)
  })

  it('does not stop while keys keep arriving', () => {
    announcer.type()
    jest.advanceTimersByTime(TypingTiming.AGENT_IDLE_STOP_MS - 1)
    announcer.type()
    jest.advanceTimersByTime(TypingTiming.AGENT_IDLE_STOP_MS - 1)
    expect(sendStop).not.toHaveBeenCalled()
  })

  it('stops at once on demand, and only if it had started', () => {
    announcer.stop()
    expect(sendStop).not.toHaveBeenCalled()
    announcer.type()
    announcer.stop()
    announcer.stop()
    expect(sendStop).toHaveBeenCalledTimes(1)
  })

  it('starts again after a stop', () => {
    announcer.type()
    announcer.stop()
    announcer.type()
    expect(sendStart).toHaveBeenCalledTimes(2)
  })

  it('tries the start again at the next key when nothing went out', () => {
    sendStart.mockReturnValueOnce(false)
    announcer.type()
    at += 100
    announcer.type()
    expect(sendStart).toHaveBeenCalledTimes(2)
    announcer.stop()
    expect(sendStop).toHaveBeenCalledTimes(1)
  })
})
