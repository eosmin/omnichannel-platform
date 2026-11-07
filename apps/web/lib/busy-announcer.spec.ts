import { readBusyCount, startBusy, subscribeToBusy } from './busy-announcer'

describe('busy announcer', () => {
  it('counts the buttons that wait and tells the listeners', () => {
    const listener = jest.fn()
    const stopListening = subscribeToBusy(listener)
    const first = startBusy()
    const second = startBusy()
    expect(readBusyCount()).toBe(2)
    first()
    expect(readBusyCount()).toBe(1)
    second()
    expect(readBusyCount()).toBe(0)
    expect(listener).toHaveBeenCalledTimes(4)
    stopListening()
  })

  it('counts a button once, however many times it stops', () => {
    const stop = startBusy()
    stop()
    stop()
    expect(readBusyCount()).toBe(0)
  })
})
