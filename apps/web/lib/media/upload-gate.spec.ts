import { uploadGate } from './upload-gate'

function deferred() {
  let done: () => void = () => undefined
  const promise = new Promise<void>(resolve => {
    done = resolve
  })
  return { promise, done }
}

describe('uploadGate', () => {
  it('runs at most `size` tasks at once and starts the next as one ends, in order', async () => {
    const gate = uploadGate(2)
    const controller = new AbortController()
    const started: number[] = []
    const holds = [deferred(), deferred(), deferred()]
    const runs = holds.map((hold, index) =>
      gate(async () => {
        started.push(index)
        await hold.promise
      }, controller.signal)
    )
    await Promise.resolve()
    expect(started).toEqual([0, 1])

    holds[0]?.done()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(started).toEqual([0, 1, 2])

    holds[1]?.done()
    holds[2]?.done()
    await Promise.all(runs)
  })

  it('never runs more than `size` at once, even when a newcomer arrives as a place is freed', async () => {
    const gate = uploadGate(1)
    const signal = new AbortController().signal
    let active = 0
    let most = 0
    const task = async (): Promise<void> => {
      active += 1
      most = Math.max(most, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active -= 1
    }
    const first = gate(task, signal)
    const second = gate(task, signal)
    await first
    // The newcomer comes in the turn after the first ended, before the second woke
    const third = gate(task, signal)
    await Promise.all([second, third])
    expect(most).toBe(1)
  })

  it('lets a waiting task leave when its signal aborts, without running it', async () => {
    const gate = uploadGate(1)
    const hold = deferred()
    const first = gate(() => hold.promise, new AbortController().signal)
    const controller = new AbortController()
    let ran = false
    const second = gate(() => {
      ran = true
      return Promise.resolve()
    }, controller.signal)
    controller.abort(new Error('gone'))
    await expect(second).rejects.toThrow('gone')
    hold.done()
    await first
    expect(ran).toBe(false)
  })

  it('frees the place when a task fails', async () => {
    const gate = uploadGate(1)
    const signal = new AbortController().signal
    await expect(gate(() => Promise.reject(new Error('boom')), signal)).rejects.toThrow('boom')
    await expect(gate(() => Promise.resolve('next'), signal)).resolves.toBe('next')
  })
})
