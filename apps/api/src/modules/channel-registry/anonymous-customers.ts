import type { ChannelAnonymitySource } from '@platform/core/domain'

// What the interface needs to name a customer nobody named (a visitor of a site) without knowing any channel:
// the plugin declares it, the registry keeps it, and the views carry it. It is read from the registry on every
// answer, so it needs no permission of its own and holds nothing of the customer.
export type WithAnonymous<T> = T & { anonymousCustomers: boolean }

export function withAnonymousCustomers<T extends { channelType: string }>(
  source: ChannelAnonymitySource,
  item: T
): T & { anonymousCustomers: boolean } {
  return { ...item, anonymousCustomers: source.anonymousOf(item.channelType) }
}

export type WithAnonymousPage<P extends { data: unknown[] }> = Omit<P, 'data'> & {
  data: WithAnonymous<P['data'][number]>[]
}

export function withAnonymousPage<T extends { channelType: string }, P extends { data: T[] }>(
  source: ChannelAnonymitySource,
  page: P
): WithAnonymousPage<P> {
  return { ...page, data: page.data.map(item => withAnonymousCustomers(source, item)) }
}

export type WithAnonymousIdentities<T extends { identities: { channelType: string }[] }> = Omit<
  T,
  'identities'
> & { identities: WithAnonymous<T['identities'][number]>[] }

export function withAnonymousIdentities<T extends { identities: { channelType: string }[] }>(
  source: ChannelAnonymitySource,
  customer: T
): WithAnonymousIdentities<T> {
  return {
    ...customer,
    identities: customer.identities.map(identity => withAnonymousCustomers(source, identity))
  }
}
