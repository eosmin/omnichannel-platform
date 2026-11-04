import type { CustomerDetailView } from '@platform/api-client'
import { ChannelIds } from '@platform/core/domain'

// How many characters of an identity the interface shows when a customer has no name ("····ab98")
const IDENTITY_TAIL = 4

// What names a customer in the profile: the name, else the e-mail, the phone, or what the first
// channel calls them. Null when nothing does (the screen says "Unnamed customer").
export function customerDisplayName(
  customer: Pick<CustomerDetailView, 'name' | 'email' | 'phone' | 'identities'>
): string | null {
  const first = customer.identities[0]
  // The identity of a visitor of the web widget is a random id: not a name, so the visitor is named
  // as the inbox names them (`visitorTail`)
  const isVisitor = first?.channelType === ChannelIds.WEB_WIDGET
  const candidates = [
    customer.name,
    customer.email,
    customer.phone,
    first?.displayName,
    isVisitor ? null : first?.channelIdentity
  ]
  return (
    candidates.find(value => value !== null && value !== undefined && value.trim() !== '') ?? null
  )
}

// The end of the id of a web widget visitor nothing else names, for "Visitante ····ab98"; null when
// there is no identity to take it from
export function visitorTail(customer: Pick<CustomerDetailView, 'identities'>): string | null {
  const first = customer.identities[0]
  return first?.channelType === ChannelIds.WEB_WIDGET && first.channelIdentity !== ''
    ? first.channelIdentity.slice(-IDENTITY_TAIL)
    : null
}

export function initialsOfName(name: string | null): string {
  if (name === null) return '?'
  const words = name.trim().split(/\s+/u).slice(0, 2)
  return words.map(word => [...word][0]?.toUpperCase() ?? '').join('') || '?'
}

// The row of the customers page has no identities: the name, else the e-mail, else the phone
export function customerListLabel(
  customer: Pick<CustomerDetailView, 'name' | 'email' | 'phone'>
): string | null {
  const found = [customer.name, customer.email, customer.phone].find(
    value => value !== null && value.trim() !== ''
  )
  return found ?? null
}
