import type { CursorPage } from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'

import { type Db } from './customers.support'

export interface TagView {
  id: string
  name: string
  color: string
}

export interface IdentityView {
  id: string
  channelType: string
  channelIdentity: string
  displayName: string | null
  lastInboundAt: Date | null
}

export interface AddressView {
  id: string
  label: string | null
  line1: string
  line2: string | null
  city: string
  state: string | null
  postalCode: string | null
  country: string
  isDefault: boolean
}

export interface CustomerListItem {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  isCaution: boolean
  channels: string[]
  tags: TagView[]
  createdAt: Date
}

export interface CustomerDetail {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  locale: string | null
  isCaution: boolean
  cautionReason: string | null
  identities: IdentityView[]
  addresses: AddressView[]
  tags: TagView[]
  createdAt: Date
  updatedAt: Date
}

export type CustomerPage = CursorPage<CustomerListItem>

export const TAG_SELECT = { id: true, name: true, color: true } as const
export const IDENTITY_SELECT = {
  id: true,
  channelType: true,
  channelIdentity: true,
  displayName: true,
  lastInboundAt: true
} as const
export const ADDRESS_SELECT = {
  id: true,
  label: true,
  line1: true,
  line2: true,
  city: true,
  state: true,
  postalCode: true,
  country: true,
  isDefault: true
} as const

export const LIST_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  isCaution: true,
  createdAt: true,
  identities: { select: { channelType: true } },
  tags: { select: TAG_SELECT, orderBy: { name: 'asc' } }
} as const

export function listItem(row: {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  isCaution: boolean
  createdAt: Date
  identities: { channelType: string }[]
  tags: TagView[]
}): CustomerListItem {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    isCaution: row.isCaution,
    channels: [...new Set(row.identities.map(identity => identity.channelType))],
    tags: row.tags,
    createdAt: row.createdAt
  }
}

// One customer with what the profile shows. A customer absorbed by a merge is not found.
export async function customerDetail(
  db: Db,
  storeId: string,
  customerId: string
): Promise<CustomerDetail> {
  const row = await db.customer.findFirst({
    where: { id: customerId, storeId, mergedIntoId: null },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      locale: true,
      isCaution: true,
      cautionReason: true,
      createdAt: true,
      updatedAt: true,
      identities: { select: IDENTITY_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      addresses: { select: ADDRESS_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      tags: { select: TAG_SELECT, orderBy: { name: 'asc' } }
    }
  })
  if (row === null) throw resourceNotFound('customer')
  return row
}
