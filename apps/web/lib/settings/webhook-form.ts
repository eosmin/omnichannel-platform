import { isPlainHttpsUrl, WebhookEvents, WebhookLimits } from '@platform/core/domain'

import type { UpdateWebhookInput, WebhookView } from './webhooks-requests'

// The form of a webhook: an https address and the events it follows. The api checks that the address leads to the public
// internet (it needs the resolver); this checks what can be told from the text, so the person sees it before the call.

export interface WebhookDraft {
  url: string
  events: string[]
}

export type WebhookProblem =
  'urlRequired' | 'urlTooLong' | 'urlNotHttps' | 'urlFragment' | 'urlPort' | 'noEvents'

// The only port a delivery goes to
const HTTPS_PORT = ''

export function emptyWebhookDraft(): WebhookDraft {
  return { url: '', events: [] }
}

export function webhookDraftOf(webhook: WebhookView): WebhookDraft {
  return { url: webhook.url, events: [...webhook.events] }
}

export function webhookProblems(draft: WebhookDraft): WebhookProblem[] {
  const problems: WebhookProblem[] = []
  const url = draft.url.trim()
  if (url === '') problems.push('urlRequired')
  else if (url.length > WebhookLimits.URL_MAX_LENGTH) problems.push('urlTooLong')
  else if (!isPlainHttpsUrl(url)) problems.push('urlNotHttps')
  else {
    const parsed = new URL(url)
    if (parsed.hash !== '') problems.push('urlFragment')
    if (parsed.port !== HTTPS_PORT) problems.push('urlPort')
  }
  if (draft.events.length === 0) problems.push('noEvents')
  return problems
}

// The events, grouped by what they are about: the text before the dot of the name ("order" of "order.created"), in the order
// the platform lists them
export interface EventGroup {
  group: string
  events: string[]
}

export function eventGroups(events: readonly string[] = WebhookEvents): EventGroup[] {
  const groups = new Map<string, string[]>()
  for (const event of events) {
    const group = event.split('.')[0] ?? event
    groups.set(group, [...(groups.get(group) ?? []), event])
  }
  return [...groups].map(([group, list]) => ({ group, events: list }))
}

export function toggleEvent(events: readonly string[], event: string): string[] {
  return events.includes(event) ? events.filter(item => item !== event) : [...events, event]
}

// Set or clear a whole group at once: all of its events are in, or none
export function setGroup(events: readonly string[], group: EventGroup, on: boolean): string[] {
  const rest = events.filter(event => !group.events.includes(event))
  return on ? [...rest, ...group.events] : rest
}

// Only what changed, because the api refuses an empty patch; the events are compared as sets
export function webhookChanges(webhook: WebhookView, draft: WebhookDraft): UpdateWebhookInput {
  const changes: UpdateWebhookInput = {}
  const url = draft.url.trim()
  if (url !== webhook.url) changes.url = url
  const before = new Set(webhook.events)
  const same = draft.events.length === before.size && draft.events.every(event => before.has(event))
  if (!same) changes.events = [...draft.events]
  return changes
}
