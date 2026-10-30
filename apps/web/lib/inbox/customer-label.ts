import type { ConversationListItemView } from '@platform/api-client'

type Customer = ConversationListItemView['customer']

// How the list names a customer (Step 2.8, 1c-2): the name, then @username, then the end of the
// channel identity for the interface to put in "Instagram customer ····1234"
export type CustomerLabel =
  | { kind: 'name'; text: string }
  | { kind: 'username'; text: string }
  | { kind: 'identity'; lastDigits: string }

const IDENTITY_TAIL = 4

export function customerLabelOf(customer: Customer): CustomerLabel {
  const name = customer.name?.trim()
  if (name !== undefined && name !== '') return { kind: 'name', text: name }
  // Some plugins keep the handle with its @, some without
  const username = customer.username?.trim().replace(/^@+/, '')
  if (username !== undefined && username !== '') return { kind: 'username', text: `@${username}` }
  return { kind: 'identity', lastDigits: customer.displayIdentity.slice(-IDENTITY_TAIL) }
}

// Two letters for the avatar that shows when there is no photo or it fails to load
export function initialsOf(label: CustomerLabel): string {
  if (label.kind === 'identity') return '#'
  const words = label.text.replace(/^@/, '').split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0]]
  return letters
    .map(word => Array.from(word ?? '')[0] ?? '')
    .join('')
    .toUpperCase()
}
