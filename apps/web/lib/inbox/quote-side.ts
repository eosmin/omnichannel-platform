import { AuthorType } from '@platform/core/domain'

export type QuoteSide = 'customer' | 'team'

// Whose message a quote shows. The thread keeps the customer on the left and everyone else (agents, the
// owner's phone, a plugin) on the right, so the quote says which side it points at.
export const quoteSideOf = (authorType: string): QuoteSide =>
  authorType === String(AuthorType.CUSTOMER) ? 'customer' : 'team'
