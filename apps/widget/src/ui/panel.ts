import { WidgetAuthors, WidgetDeliveryStates, WidgetLimits } from '@platform/core/domain'

import type { WidgetText } from '../i18n'
import type { ChatMessage, VisitorProfile } from '../types'

import { el, icon, Icons } from './dom'
import { applyStyles } from './styles'

export interface PanelProps {
  storeName: string
  text: WidgetText
  away: boolean
  // Ask for a name, an email and a phone before the first message; false when the store did not turn it
  // on or the visitor already answered
  preChat: boolean
  // The visitor answered the form: what they typed (nothing when they left it blank)
  onProfile: (profile: VisitorProfile) => void
  onSend: (content: string) => void
  onRetry: (key: string) => void
  // The visitor is writing; the session decides how often the server hears of it
  onTyping: () => void
}

export interface Panel {
  setAgentTyping(active: boolean): void
  update(messages: readonly ChatMessage[]): void
  destroy(): void
}

const HOST_ID = 'platform-widget'
const ENTER = 'Enter'
const ESCAPE = 'Escape'
// What a number is typed with: digits, a plus, spaces, dots, dashes and brackets; the api reads it
// An address with something before and after the @ and a dot in the domain, as the api reads it
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_PATTERN = /^\+?[\d\s().-]{6,}$/

// The launcher and the panel, in a shadow root on the page. Null when the page is not able to hold it.
const keyOf = (entry: string): string => entry.slice(0, entry.lastIndexOf('|'))
const sameKeys = (a: readonly string[], b: readonly string[]): boolean =>
  a.every((entry, index) => keyOf(entry) === keyOf(b[index] ?? ''))

export function mountPanel(props: PanelProps): Panel | null {
  if (document.getElementById(HOST_ID) !== null) return null
  const host = el('div', '')
  host.id = HOST_ID
  const root = host.attachShadow({ mode: 'open' })
  if (!applyStyles(root)) return null

  const { text } = props
  const launcher = el('button', 'launcher', [icon(Icons.chat)])
  launcher.type = 'button'
  launcher.setAttribute('aria-label', text.open)
  launcher.setAttribute('aria-expanded', 'false')

  const closeButton = el('button', 'icon-button', [icon(Icons.close)])
  closeButton.type = 'button'
  closeButton.setAttribute('aria-label', text.close)
  const header = el('div', 'header', [el('span', 'title', [props.storeName]), closeButton])

  const away = el('p', 'away', [text.away])
  away.hidden = !props.away
  const list = el('div', 'messages')
  list.setAttribute('role', 'log')
  list.setAttribute('aria-live', 'polite')

  // Read out when it appears (a polite status), but not again while it stays
  const typing = el('p', 'typing', [text.teamTyping])
  typing.setAttribute('role', 'status')
  typing.hidden = true

  const field = el('textarea', 'field')
  field.rows = 1
  field.maxLength = WidgetLimits.CONTENT_MAX_LENGTH
  field.setAttribute('aria-label', text.inputLabel)
  field.placeholder = text.inputLabel
  const sendButton = el('button', 'send', [icon(Icons.send)])
  sendButton.type = 'submit'
  sendButton.setAttribute('aria-label', text.send)
  sendButton.disabled = true
  const form = el('form', 'composer', [field, sendButton])

  // The form that comes first when the store asks for it. Every field is optional, and a value that is
  // not an address or a number is refused here, because the server would drop it without a word.
  const fields = (
    [
      ['name', 'text', 'name', text.nameLabel],
      ['email', 'email', 'email', text.emailLabel],
      ['phone', 'tel', 'tel', text.phoneLabel]
    ] as const
  ).map(([key, type, autocomplete, label]) => {
    const input = el('input', 'input')
    input.type = type
    input.autocomplete = autocomplete
    input.name = key
    input.maxLength = WidgetLimits.PROFILE_FIELD_MAX_LENGTH
    const caption = el('label', 'label', [label, input])
    return { key, input, caption }
  })
  const problem = el('p', 'problem')
  problem.setAttribute('role', 'alert')
  problem.hidden = true
  const startButton = el('button', 'start', [text.startChat])
  startButton.type = 'submit'
  const preChatForm = el('form', 'prechat', [
    el('p', 'intro', [text.preChatIntro]),
    ...fields.map(field => field.caption),
    problem,
    startButton
  ])
  preChatForm.noValidate = true
  preChatForm.hidden = !props.preChat

  const panel = el('section', 'panel', [header, away, preChatForm, list, typing, form])
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', props.storeName)
  panel.hidden = true
  root.append(panel, launcher)
  // While the form is up there is no conversation to show or write in
  const showChat = (shown: boolean): void => {
    list.hidden = !shown
    form.hidden = !shown
  }
  showChat(!props.preChat)

  let open = false
  let seen = 0
  let latest: readonly ChatMessage[] = []
  // What the list shows now, one entry per line, so that a change touches only what changed
  let drawn: string[] = []

  const setOpen = (next: boolean): void => {
    open = next
    panel.hidden = !next
    launcher.setAttribute('aria-expanded', String(next))
    if (next) {
      seen = latest.length
      launcher.classList.remove('launcher--unread')
      if (preChatForm.hidden) field.focus()
      else fields[0]?.input.focus()
      list.scrollTop = list.scrollHeight
    } else {
      launcher.focus()
    }
  }

  const submit = (): void => {
    const content = field.value.trim()
    if (content === '') return
    field.value = ''
    sendButton.disabled = true
    props.onSend(content)
  }

  preChatForm.addEventListener('submit', event => {
    event.preventDefault()
    const profile: VisitorProfile = {}
    for (const { key, input } of fields) {
      const value = input.value.trim()
      if (value !== '') profile[key] = value
    }
    const email = fields[1]?.input
    if (profile.email !== undefined && !EMAIL_PATTERN.test(profile.email)) {
      problem.textContent = text.invalidEmail
      problem.hidden = false
      email?.focus()
      return
    }
    if (profile.phone !== undefined && !PHONE_PATTERN.test(profile.phone)) {
      problem.textContent = text.invalidPhone
      problem.hidden = false
      fields[2]?.input.focus()
      return
    }
    preChatForm.hidden = true
    showChat(true)
    props.onProfile(profile)
    field.focus()
  })
  preChatForm.addEventListener('input', () => {
    problem.hidden = true
  })
  launcher.addEventListener('click', () => setOpen(!open))
  closeButton.addEventListener('click', () => setOpen(false))
  panel.addEventListener('keydown', event => {
    if (event.key === ESCAPE) setOpen(false)
  })
  field.addEventListener('input', () => {
    sendButton.disabled = field.value.trim() === ''
    if (!sendButton.disabled) props.onTyping()
  })
  field.addEventListener('keydown', event => {
    if (event.key === ENTER && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      submit()
    }
  })
  form.addEventListener('submit', event => {
    event.preventDefault()
    submit()
  })

  const row = (message: ChatMessage): HTMLElement => {
    const mine = message.from === WidgetAuthors.VISITOR
    const author = el('span', 'sr-only', [mine ? text.you : text.team])
    const bubble = el('p', 'bubble', [message.content])
    const item = el('div', `msg msg--${mine ? 'visitor' : 'team'} msg--${message.state}`, [
      author,
      bubble
    ])
    if (mine && message.seen) item.append(el('span', 'seen', [text.seen]))
    if (message.state === WidgetDeliveryStates.FAILED) {
      const retry = el('button', 'retry', [text.retry])
      retry.type = 'button'
      retry.addEventListener('click', () => props.onRetry(message.key))
      item.append(el('span', 'failure', [text.failed, retry]))
    }
    return item
  }

  // A live region announces what is added to it; rebuilding it would read the whole conversation again
  // at every change, so lines are appended and only the one whose state changed is replaced
  const draw = (messages: readonly ChatMessage[]): void => {
    const next = messages.map(
      message => `${message.key}|${message.state}${message.seen ? '+seen' : ''}`
    )
    const prefix = drawn.length > 0 && drawn.every((entry, index) => entry === next[index])
    if (messages.length === 0) {
      list.replaceChildren(el('p', 'empty', [text.empty]))
    } else if (prefix) {
      list.append(...messages.slice(drawn.length).map(row))
    } else if (drawn.length === next.length && sameKeys(drawn, next)) {
      next.forEach((entry, index) => {
        const message = messages[index]
        if (entry !== drawn[index] && message !== undefined)
          list.children[index]?.replaceWith(row(message))
      })
    } else {
      list.replaceChildren(...messages.map(row))
    }
    drawn = next
  }

  document.body.append(host)
  return {
    setAgentTyping(active) {
      const wasAtEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40
      typing.hidden = !active
      // The indicator takes room from the list: keep the last line in view
      if (wasAtEnd) list.scrollTop = list.scrollHeight
    },
    update(messages) {
      const grew = messages.length > latest.length
      latest = messages
      const stickToEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40
      draw(messages)
      if (stickToEnd || open) list.scrollTop = list.scrollHeight
      const last = messages[messages.length - 1]
      if (!open && grew && messages.length > seen && last?.from === WidgetAuthors.TEAM) {
        launcher.classList.add('launcher--unread')
      }
      if (open) seen = messages.length
    },
    destroy() {
      host.remove()
    }
  }
}
