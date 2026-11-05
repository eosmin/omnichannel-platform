import { createSubmitGuard } from './submit-guard'

// The forms disabled their button and read `isPending` to refuse a second send, but React Query shows
// `isPending` a render after `mutate()`: five Enters in a row got through (QA TRX-01, 1 created and 4
// refused as duplicates, with the dialog left open). The guard is a plain flag, set in the same tick.
describe('createSubmitGuard', () => {
  it('lets one send in and refuses the rest until it ends', () => {
    const guard = createSubmitGuard()

    const entered = [guard.enter(), guard.enter(), guard.enter(), guard.enter(), guard.enter()]

    expect(entered).toEqual([true, false, false, false, false])
  })

  it('lets the next send in once the first has ended, whether it worked or not', () => {
    const guard = createSubmitGuard()
    guard.enter()
    guard.leave()

    expect(guard.enter()).toBe(true)
    expect(guard.enter()).toBe(false)
  })

  it('does not stay shut when it is left twice', () => {
    const guard = createSubmitGuard()
    guard.enter()
    guard.leave()
    guard.leave()

    expect(guard.enter()).toBe(true)
  })

  it('is one flag for each form', () => {
    const first = createSubmitGuard()
    const second = createSubmitGuard()
    first.enter()

    expect(second.enter()).toBe(true)
  })
})
