import { type FocusTarget, openerOf, returnFocus } from './focus-return'

const element = (isConnected = true): FocusTarget & { focus: jest.Mock } => ({
  isConnected,
  focus: jest.fn()
})

const closeEvent = (
  defaultPrevented = false
): { defaultPrevented: boolean; preventDefault: jest.Mock } => {
  const event = { defaultPrevented, preventDefault: jest.fn() }
  event.preventDefault.mockImplementation(() => {
    event.defaultPrevented = true
  })
  return event
}

describe('returnFocus', () => {
  const holds = (): boolean => true
  it('puts the focus back on the button that opened the dialog and keeps Radix from moving it', () => {
    const opener = element()
    const event = closeEvent()

    expect(returnFocus(event, opener, holds)).toBe(true)

    expect(opener.focus).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['there is no opener', null],
    ['the opener left the page', element(false)]
  ])('leaves the default alone when %s', (_name, opener) => {
    const event = closeEvent()

    expect(returnFocus(event, opener, holds)).toBe(false)

    expect(event.preventDefault).not.toHaveBeenCalled()
    if (opener !== null) expect((opener as { focus: jest.Mock }).focus).not.toHaveBeenCalled()
  })

  it('leaves the default alone when the opener ignores the focus (disabled, hidden or inert)', () => {
    const opener = element()
    const event = closeEvent()

    expect(returnFocus(event, opener, () => false)).toBe(false)

    expect(opener.focus).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('respects a caller that already decided where the focus goes', () => {
    const opener = element()

    expect(returnFocus(closeEvent(true), opener, holds)).toBe(false)

    expect(opener.focus).not.toHaveBeenCalled()
  })
})

describe('openerOf', () => {
  it('takes an element that can hold the focus', () => {
    const button = { ...element(), tagName: 'BUTTON' }
    expect(openerOf(button)).toBe(button)
  })

  it.each([
    ['nothing', null],
    ['the body, where the focus is when nothing has it', { ...element(), tagName: 'BODY' }],
    ['something that cannot take the focus back', { tagName: 'DIV' }]
  ])('takes %s as no opener', (_name, active) => {
    expect(openerOf(active)).toBeNull()
  })
})
