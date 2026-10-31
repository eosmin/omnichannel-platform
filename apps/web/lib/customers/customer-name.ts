import type { CustomerDetailView } from '@platform/api-client'

// What names a customer in the profile: the name, else the e-mail, the phone, or what the first
// channel calls them. Null when nothing does (the screen says "Unnamed customer").
export function customerDisplayName(
  customer: Pick<CustomerDetailView, 'name' | 'email' | 'phone' | 'identities'>
): string | null {
  const first = customer.identities[0]
  const candidates = [
    customer.name,
    customer.email,
    customer.phone,
    first?.displayName,
    first?.channelIdentity
  ]
  return (
    candidates.find(value => value !== null && value !== undefined && value.trim() !== '') ?? null
  )
}

export function initialsOfName(name: string | null): string {
  if (name === null) return '?'
  const words = name.trim().split(/\s+/u).slice(0, 2)
  return words.map(word => [...word][0]?.toUpperCase() ?? '').join('') || '?'
}
