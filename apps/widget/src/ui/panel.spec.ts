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
  attachments: [],
  progress: null,
  createdAt: 'd',
  state: 'sent',
  seen: false,
  ...overrides
})

describe('mountPanel', () => {
  let mounted: Panel | null = null
  const onSend = jest.fn()
  const onOpenFile = jest.fn()
  const onProfile = jest.fn()
  const onRetry = jest.fn()
  const onTyping = jest.fn()
  const props = (overrides: Partial<PanelProps> = {}): PanelProps => ({
    storeName: 'Shop',
    text: textFor('es'),
    away: false,
    preChat: false,
    onProfile,
    onSend,
    onOpenFile,
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
    expect(onSend).toHaveBeenCalledWith('hola', [])
    expect(field.value).toBe('')

    field.value = 'otra'
    field.dispatchEvent(new Event('input'))
    q<HTMLFormElement>('.composer').dispatchEvent(new Event('submit', { cancelable: true }))
    expect(onSend).toHaveBeenLastCalledWith('otra', [])
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
  describe('the pre-chat form', () => {
    const type = (name: string, value: string): void => {
      q<HTMLInputElement>(`input[name="${name}"]`).value = value
    }
    const submitForm = (): void => {
      q<HTMLFormElement>('.prechat').dispatchEvent(new Event('submit', { cancelable: true }))
    }

    it('comes before the conversation when the store asks for it', () => {
      mount({ preChat: true })

      expect(q<HTMLElement>('.prechat').hidden).toBe(false)
      expect(q<HTMLElement>('.messages').hidden).toBe(true)
      expect(q<HTMLElement>('.composer').hidden).toBe(true)
    })

    it('is not drawn when the store did not ask for it', () => {
      mount({ preChat: false })

      expect(q<HTMLElement>('.prechat').hidden).toBe(true)
      expect(q<HTMLElement>('.composer').hidden).toBe(false)
    })

    it('hands over what was typed and opens the conversation', () => {
      mount({ preChat: true })
      type('name', ' Ana ')
      type('email', 'ana@example.com')
      type('phone', '+503 7000 1111')

      submitForm()

      expect(onProfile).toHaveBeenCalledWith({
        name: 'Ana',
        email: 'ana@example.com',
        phone: '+503 7000 1111'
      })
      expect(q<HTMLElement>('.prechat').hidden).toBe(true)
      expect(q<HTMLElement>('.composer').hidden).toBe(false)
    })

    it('lets the visitor go on with nothing typed', () => {
      mount({ preChat: true })

      submitForm()

      expect(onProfile).toHaveBeenCalledWith({})
      expect(q<HTMLElement>('.composer').hidden).toBe(false)
    })

    it('holds the form back for an email or a phone that cannot be right', () => {
      mount({ preChat: true })
      type('email', 'a@b')

      submitForm()

      expect(onProfile).not.toHaveBeenCalled()
      expect(q('.problem').textContent).toBe('Revisa el correo.')
      type('email', '')
      type('phone', 'abc')

      submitForm()

      expect(onProfile).not.toHaveBeenCalled()
      expect(q('.problem').textContent).toBe('Revisa el teléfono.')
    })
  })
  describe('files', () => {
    const png = (name = 'a.png', size = 1000): File => {
      const file = new File(['x'], name, { type: 'image/png' })
      Object.defineProperty(file, 'size', { value: size })
      return file
    }
    const choose = (...files: File[]): void => {
      const picker = q<HTMLInputElement>('input[type="file"]')
      Object.defineProperty(picker, 'files', { value: files, configurable: true })
      picker.dispatchEvent(new Event('change'))
    }

    it('offers only the types the api takes', () => {
      mount()

      expect(q<HTMLInputElement>('input[type="file"]').accept).toContain('image/png')
      expect(q<HTMLInputElement>('input[type="file"]').accept).not.toContain('text/html')
    })

    it('keeps a chosen file beside the text, lets send go with the file alone, and clears them', () => {
      mount()
      const button = q<HTMLButtonElement>('.send')

      choose(png('foto.png', 2048))

      expect(q('.staged-file .file-name').textContent).toBe('foto.png')
      expect(q('.staged-file .file-size').textContent).toBe('2.0 KB')
      expect(button.disabled).toBe(false)
      q<HTMLFormElement>('.composer').dispatchEvent(new Event('submit', { cancelable: true }))

      expect(onSend).toHaveBeenCalledWith('', [expect.objectContaining({ name: 'foto.png' })])
      expect(shadow().querySelectorAll('.staged-file')).toHaveLength(0)
      expect(button.disabled).toBe(true)
    })

    it('takes a file off before it is sent', () => {
      mount()
      choose(png('a.png'), png('b.png'))

      q<HTMLButtonElement>('.staged-file button').click()

      expect(
        Array.from(shadow().querySelectorAll('.file-name')).map(node => node.textContent)
      ).toEqual(['b.png'])
    })

    it('says why a file is refused and keeps the others', () => {
      mount()

      choose(new File(['x'], 'a.exe', { type: 'application/x-msdownload' }), png('ok.png'))
      expect(q('.notice').textContent).toBe(textFor('es').fileTypeNotAllowed)
      expect(shadow().querySelectorAll('.staged-file')).toHaveLength(1)

      choose(png('big.png', 11 * 1024 * 1024))
      expect(q('.notice').textContent).toBe('El archivo pesa más de 10 MB.')

      choose(png('empty.png', 0))
      expect(q('.notice').textContent).toBe(textFor('es').fileEmpty)
    })

    it('takes no more files than a message may carry', () => {
      mount()

      choose(...Array.from({ length: 6 }, (_, n) => png(`${n}.png`)))

      expect(shadow().querySelectorAll('.staged-file')).toHaveLength(5)
      expect(q('.notice').textContent).toContain('5')
    })

    it('draws a file as a name and a size, and the bubble only when there is text', () => {
      const panel = mount()
      const attachment = { id: 'm1', filename: 'a.pdf', contentType: 'application/pdf', size: 3000 }

      panel.update([message({ key: 'a', content: '', attachments: [attachment] })])

      expect(q('.file .file-name').textContent).toBe('a.pdf')
      expect(q('.file .file-size').textContent).toBe('2.9 KB')
      expect(shadow().querySelector('.bubble')).toBeNull()
      panel.update([
        message({ key: 'a', content: '', attachments: [attachment] }),
        message({ key: 'b', content: 'hola' })
      ])
      expect(q('.bubble').textContent).toBe('hola')
    })

    it('asks for the link only when the file is opened, and follows it', async () => {
      const click = jest
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => undefined)
      onOpenFile.mockResolvedValue({
        url: 'https://b/f',
        filename: 'a',
        contentType: 'x',
        previewUrl: null
      })
      const panel = mount()
      panel.update([
        message({
          key: 'a',
          content: '',
          attachments: [{ id: 'm1', filename: 'a.pdf', contentType: 'x', size: 1 }]
        })
      ])
      expect(onOpenFile).not.toHaveBeenCalled()

      q<HTMLButtonElement>('button.file').click()
      await Promise.resolve()
      await Promise.resolve()

      expect(onOpenFile).toHaveBeenCalledWith('m1')
      expect(click).toHaveBeenCalledTimes(1)
      click.mockRestore()
    })

    it('does not follow a link that is not a web address', async () => {
      const click = jest
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => undefined)
      onOpenFile.mockResolvedValue({
        url: 'javascript:alert(1)',
        filename: 'a',
        contentType: 'x',
        previewUrl: null
      })
      const panel = mount()
      panel.update([
        message({
          key: 'a',
          content: '',
          attachments: [{ id: 'm1', filename: 'a.pdf', contentType: 'x', size: 1 }]
        })
      ])

      q<HTMLButtonElement>('button.file').click()
      await Promise.resolve()
      await Promise.resolve()

      expect(click).not.toHaveBeenCalled()
      expect(q('.notice').textContent).toBe(textFor('es').fileUnavailable)
      click.mockRestore()
    })

    it('says so when the link cannot be had', async () => {
      onOpenFile.mockRejectedValue(new Error('no'))
      const panel = mount()
      panel.update([
        message({
          key: 'a',
          content: '',
          attachments: [{ id: 'm1', filename: 'a.pdf', contentType: 'x', size: 1 }]
        })
      ])

      q<HTMLButtonElement>('button.file').click()
      await Promise.resolve()
      await Promise.resolve()

      expect(q('.notice').textContent).toBe(textFor('es').fileUnavailable)
    })

    it('shows a file still going up without a button, and a bar that moves in place', () => {
      const panel = mount()
      const going = { id: null, filename: 'a.png', contentType: 'image/png', size: 1 }
      panel.update([
        message({
          key: 'a',
          from: 'visitor',
          state: 'sending',
          attachments: [going],
          progress: 0.2
        })
      ])
      const bar = q<HTMLProgressElement>('progress')

      panel.update([
        message({
          key: 'a',
          from: 'visitor',
          state: 'sending',
          attachments: [going],
          progress: 0.6
        })
      ])

      expect(shadow().querySelector('button.file')).toBeNull()
      expect(q<HTMLProgressElement>('progress')).toBe(bar)
      expect(bar.value).toBe(0.6)
    })
  })

  it('brings the form back with the phone marked when the api cannot read it', () => {
    const panel = mount({ preChat: true })
    q<HTMLFormElement>('.prechat').dispatchEvent(new Event('submit', { cancelable: true }))
    expect(q<HTMLElement>('.prechat').hidden).toBe(true)

    panel.showPhoneProblem()

    expect(q<HTMLElement>('.panel').hidden).toBe(false)
    expect(q<HTMLElement>('.prechat').hidden).toBe(false)
    expect(q<HTMLElement>('.composer').hidden).toBe(true)
    expect(q('input[name="phone"]').getAttribute('aria-invalid')).toBe('true')
    expect(q('input[name="phone"]').parentElement?.querySelector('.problem')?.textContent).toBe(
      'Revisa el teléfono.'
    )
  })
})
