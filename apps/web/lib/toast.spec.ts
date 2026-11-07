import { createToasts, type ToastCall } from './toast'

const inBrowser = (): boolean => true
const text = (call: ToastCall): string => (typeof call.message === 'string' ? call.message : '')

describe('the toasts', () => {
  it('keeps what is asked before sonner has loaded, in order, and hands it over once it has', () => {
    const toasts = createToasts(inBrowser)
    const shown: string[] = []

    toasts.toast.success('saved')
    toasts.toast.error('failed', { description: 'try again' })
    toasts.toast('plain')
    expect(toasts.isRequested()).toBe(true)
    expect(shown).toEqual([])

    toasts.register(call => {
      shown.push(`${call.kind}:${text(call)}`)
    })

    expect(shown).toEqual(['success:saved', 'error:failed', 'plain:plain'])
  })

  it('shows at once what is asked after sonner has loaded', () => {
    const toasts = createToasts(inBrowser)
    const shown: string[] = []
    toasts.register(call => {
      shown.push(call.kind)
    })

    toasts.toast.info('a')
    toasts.toast.warning('b')

    expect(shown).toEqual(['info', 'warning'])
    expect(toasts.isRequested()).toBe(false)
  })

  it('does not ask for sonner until a toast is asked for, and tells the page when it is', () => {
    const toasts = createToasts(inBrowser)
    const heard = jest.fn()
    const stop = toasts.subscribe(heard)
    expect(toasts.isRequested()).toBe(false)

    toasts.toast.success('x')
    expect(heard).toHaveBeenCalledTimes(1)
    expect(toasts.isRequested()).toBe(true)
    stop()
    toasts.toast.success('y')
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('drops a toast that cannot be shown without losing the ones behind it, and can be undone', () => {
    const toasts = createToasts(inBrowser)
    const shown: string[] = []
    toasts.toast.success('a')
    toasts.toast.success('b')
    const stop = toasts.register(call => {
      if (call.message === 'a') throw new Error('bad option')
      shown.push(text(call))
    })
    expect(shown).toEqual(['b'])

    // After the Toaster is gone what is asked waits again, for the next one
    stop()
    toasts.toast.success('c')
    expect(shown).toEqual(['b'])
    toasts.register(call => {
      shown.push(text(call))
    })
    expect(shown).toEqual(['b', 'c'])
  })

  it('asks again for sonner after a failed load, and keeps what waited', () => {
    const toasts = createToasts(inBrowser)
    const heard = jest.fn()
    toasts.subscribe(heard)
    toasts.toast.error('first')
    toasts.retry()
    toasts.toast.error('second')
    expect(heard).toHaveBeenCalledTimes(2)
    const shown: string[] = []
    toasts.register(call => {
      shown.push(text(call))
    })
    expect(shown).toEqual(['first', 'second'])
  })

  it('keeps the newest when too many wait', () => {
    const toasts = createToasts(inBrowser)
    for (let index = 0; index < 30; index += 1) toasts.toast.info(`t${index}`)
    const shown: string[] = []
    toasts.register(call => {
      shown.push(text(call))
    })
    expect(shown).toHaveLength(20)
    expect(shown[0]).toBe('t10')
    expect(shown.at(-1)).toBe('t29')
  })

  it('ignores a toast asked on the server: nothing would show it and the queue is shared', () => {
    const toasts = createToasts(() => false)
    toasts.toast.error('secret of a request')
    expect(toasts.isRequested()).toBe(false)
    const shown: string[] = []
    toasts.register(call => {
      shown.push(text(call))
    })
    expect(shown).toEqual([])
  })

  it('keeps the options of a toast (an action, a duration)', () => {
    const toasts = createToasts(inBrowser)
    const options = { duration: 5000, action: { label: 'Undo', onClick: jest.fn() } }
    const seen: unknown[] = []
    toasts.toast('hi', options)
    toasts.register(call => {
      seen.push(call.options)
    })
    expect(seen).toEqual([options])
  })
})
