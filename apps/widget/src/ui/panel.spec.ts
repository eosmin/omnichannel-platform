import { textFor } from '../i18n'
import type { ChatMessage } from '../types'

import { mountPanel, type Panel, type PanelProps } from './panel'

// jsdom has no constructable stylesheets: the panel needs them, so the browser's are stood in for
class FakeSheet {
  css = ''
  replaceSync(css: string): void {
    this.css = css
  }
}

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
  key: 'k',
  serverId: 'k',
  from: 'team',
  content: 'hola',
  createdAt: 'd',
  state: 'sent',
  seen: false,
  ...overrides
})

describe('mountPanel', () => {
  let mounted: Panel | null = null
  const onSend = jest.fn()
  const onRetry = jest.fn()
  const onTyping = jest.fn()
  const props = (overrides: Partial<PanelProps> = {}): PanelProps => ({
    storeName: 'Shop',
    text: textFor('es'),
    away: false,
    onSend,
    onRetry,
    onTyping,
    ...overrides
  })
  const mount = (overrides: Partial<PanelProps> = {}): Panel => {
    mounted = mountPanel(props(overrides))
    if (mounted === null) throw new Error('not mounted')
    return mounted
  }
  const shadow = (): ShadowRoot => {
    const root = document.getElementById('platform-widget')?.shadowRoot
    if (root === null || root === undefined) throw new Error('not mounted')
    return root
  }
  const q = <T extends Element>(selector: string): T => {
    const found = shadow().querySelector<T>(selector)
    if (found === null) throw new Error(`missing ${selector}`)
    return found
  }

  beforeAll(() => {
    Object.defineProperty(globalThis, 'CSSStyleSheet', { value: FakeSheet, configurable: true })
    Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
      value: [],
      writable: true,
      configurable: true
    })
  })
  afterEach(() => {
    mounted?.destroy()
    mounted = null
    jest.clearAllMocks()
  })

  it('puts a launcher on the page and keeps the panel closed', () => {
    mount()

    expect(q<HTMLButtonElement>('.launcher').getAttribute('aria-expanded')).toBe('false')
    expect(q<HTMLElement>('.panel').hidden).toBe(true)
    expect(q('.title').textContent).toBe('Shop')
  })

  it('does not put a second widget on a page that has one', () => {
    mount()

    expect(mountPanel(props())).toBeNull()
  })

  it('stays out of a browser that cannot hold styles without markup', () => {
    Object.defineProperty(globalThis, 'CSSStyleSheet', { value: undefined, configurable: true })

    expect(mountPanel(props())).toBeNull()
    expect(document.getElementById('platform-widget')).toBeNull()
    Object.defineProperty(globalThis, 'CSSStyleSheet', { value: FakeSheet, configurable: true })
  })

  it('opens and closes with the launcher, the close button and Escape', () => {
    mount()
    const panelNode = q<HTMLElement>('.panel')

    q<HTMLButtonElement>('.launcher').click()
    expect(panelNode.hidden).toBe(false)
    q<HTMLButtonElement>('.icon-button').click()
    expect(panelNode.hidden).toBe(true)
    q<HTMLButtonElement>('.launcher').click()
    panelNode.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(panelNode.hidden).toBe(true)
  })

  it('shows that the team is typing only while they are', () => {
    const panel = mount()

    expect(q<HTMLElement>('.typing').hidden).toBe(true)
    panel.setAgentTyping(true)
    expect(q<HTMLElement>('.typing').hidden).toBe(false)
    expect(q('.typing').textContent).toBe('El equipo está escribiendo…')
    expect(q('.typing').getAttribute('role')).toBe('status')
    panel.setAgentTyping(false)
    expect(q<HTMLElement>('.typing').hidden).toBe(true)
  })

  it('tells the session the visitor writes, and not when the field is emptied', () => {
    mount()
    const field = q<HTMLTextAreaElement>('.field')

    field.value = 'ho'
    field.dispatchEvent(new Event('input'))
    field.value = ''
    field.dispatchEvent(new Event('input'))

    expect(onTyping).toHaveBeenCalledTimes(1)
  })

  it('marks a message of the visitor as seen, in place, once an agent read it', () => {
    const panel = mount()
    panel.update([message({ key: 'a', from: 'visitor' })])
    const bubble = q('.bubble')

    expect(shadow().querySelector('.seen')).toBeNull()
    panel.update([message({ key: 'a', from: 'visitor', seen: true })])

    expect(q('.seen').textContent).toBe('Visto')
    expect(q('.bubble')).not.toBe(bubble)
    expect(shadow().querySelectorAll('.msg')).toHaveLength(1)
  })

  it('says the store is away only when it is', () => {
    mount({ away: true })

    expect(q<HTMLElement>('.away').hidden).toBe(false)
    expect(q('.away').textContent).toContain('no estamos en línea')
  })

  it('draws the messages as text, never as markup', () => {
    const panel = mount()

    panel.update([
      message({ key: 'a', content: '<img src=x onerror=alert(1)>' }),
      message({ key: 'b', from: 'visitor', content: 'yo' })
    ])

    expect(shadow().querySelector('img')).toBeNull()
    expect(shadow().querySelectorAll('.msg')).toHaveLength(2)
    expect(q('.msg--team .bubble').textContent).toBe('<img src=x onerror=alert(1)>')
    expect(q('.msg--visitor').className).toContain('msg--sent')
  })

  it('invites the visitor to write when there is nothing yet', () => {
    const panel = mount()

    panel.update([])

    expect(q('.empty').textContent).toBe(textFor('es').empty)
  })

  it('sends what is written with Enter or the button, and not an empty or blank text', () => {
    mount()
    const field = q<HTMLTextAreaElement>('.field')
    const button = q<HTMLButtonElement>('.send')
    expect(button.disabled).toBe(true)

    field.value = '   '
    field.dispatchEvent(new Event('input'))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    expect(onSend).not.toHaveBeenCalled()

    field.value = '  hola  '
    field.dispatchEvent(new Event('input'))
    expect(button.disabled).toBe(false)
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    expect(onSend).toHaveBeenCalledWith('hola')
    expect(field.value).toBe('')

    field.value = 'otra'
    field.dispatchEvent(new Event('input'))
    q<HTMLFormElement>('.composer').dispatchEvent(new Event('submit', { cancelable: true }))
    expect(onSend).toHaveBeenLastCalledWith('otra')
  })

  it('leaves a line break for Shift+Enter', () => {
    mount()
    const field = q<HTMLTextAreaElement>('.field')
    field.value = 'hola'

    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, cancelable: true })
    )

    expect(onSend).not.toHaveBeenCalled()
  })

  it('offers to send again a message that failed', () => {
    const panel = mount()

    panel.update([message({ key: 'k9', from: 'visitor', state: 'failed' })])
    q<HTMLButtonElement>('.retry').click()

    expect(onRetry).toHaveBeenCalledWith('k9')
  })

  it('marks the launcher when the team writes while the panel is closed, until it is opened', () => {
    const panel = mount()
    const launcher = q<HTMLButtonElement>('.launcher')

    panel.update([message({ key: 'a' })])
    expect(launcher.classList.contains('launcher--unread')).toBe(true)

    launcher.click()
    expect(launcher.classList.contains('launcher--unread')).toBe(false)
  })

  it('does not mark the launcher for what the visitor wrote', () => {
    const panel = mount()

    panel.update([message({ key: 'a', from: 'visitor' })])

    expect(q('.launcher').classList.contains('launcher--unread')).toBe(false)
  })

  it('adds a line without drawing the others again, and replaces only the one that changed', () => {
    const panel = mount()
    panel.update([message({ key: 'a' }), message({ key: 'b', from: 'visitor', state: 'sending' })])
    const [first, second] = Array.from(shadow().querySelectorAll('.msg'))

    panel.update([
      message({ key: 'a' }),
      message({ key: 'b', from: 'visitor', state: 'sending' }),
      message({ key: 'c' })
    ])
    expect(Array.from(shadow().querySelectorAll('.msg')).slice(0, 2)).toEqual([first, second])

    panel.update([
      message({ key: 'a' }),
      message({ key: 'b', from: 'visitor', state: 'sent' }),
      message({ key: 'c' })
    ])
    const after = Array.from(shadow().querySelectorAll('.msg'))
    expect(after[0]).toBe(first)
    expect(after[1]).not.toBe(second)
    expect(after[1]?.className).toContain('msg--sent')
    expect(after).toHaveLength(3)
  })
})
