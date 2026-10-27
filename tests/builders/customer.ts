import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'
import { ChannelType } from '@platform/core/domain'

export interface CustomerInput {
  storeId: string
  name?: string
  phone?: string
  // Rows that are listed by age get an age of their own, so that the order never depends on the clock
  createdAt?: Date
}

// Builders write as the owner, so that a suite can put a row in any store
export async function createCustomer(
  owner: OwnerClient,
  input: CustomerInput
): Promise<{ id: string; name: string }> {
  const name = input.name ?? `customer-${randomUUID().slice(0, 8)}`
  return owner.customer.create({
    data: {
      storeId: input.storeId,
      name,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      ...(input.phone === undefined
        ? {}
        : { phone: input.phone, phoneNormalized: input.phone.replace(/\D/g, '') })
    },
    select: { id: true, name: true }
  }) as Promise<{ id: string; name: string }>
}

// Remembers whose each identity is: the route that reaches an identity names its customer too
export const customerOfIdentity = new Map<string, string>()

export async function createCustomerIdentity(
  owner: OwnerClient,
  input: { storeId: string; customerId?: string; channelType?: string; handle?: string }
): Promise<{ id: string; customerId: string }> {
  const customerId = input.customerId ?? (await createCustomer(owner, input)).id
  const identity = await owner.customerIdentity.create({
    data: {
      storeId: input.storeId,
      customerId,
      channelType: input.channelType ?? ChannelType.INSTAGRAM,
      channelIdentity: input.handle ?? `ig-${randomUUID().slice(0, 12)}`
    },
    select: { id: true }
  })
  customerOfIdentity.set(identity.id, customerId)
  return { id: identity.id, customerId }
}

// Remembers the survivor of each merge: the route that undoes it names the survivor
export const survivorOfMerge = new Map<string, string>()

// A merge that was made less than 30 days ago, of two customers that have nothing else
export async function createCustomerMerge(
  owner: OwnerClient,
  input: { storeId: string }
): Promise<{ id: string; survivorId: string; absorbedId: string }> {
  const survivor = await createCustomer(owner, input)
  const absorbed = await createCustomer(owner, input)
  await owner.customer.update({
    where: { id: absorbed.id },
    data: { mergedIntoId: survivor.id }
  })
  const merge = await owner.customerMerge.create({
    data: {
      storeId: input.storeId,
      survivorId: survivor.id,
      absorbedId: absorbed.id,
      snapshot: {
        survivorBefore: {},
        survivorAfter: {},
        survivorTagIdsBefore: [],
        absorbedTagIds: [],
        identityIds: [],
        conversationIds: [],
        orderIds: [],
        addressIds: [],
        defaultedAddressIds: [],
        noteIds: [],
        mediaIds: [],
        fieldChoices: {}
      },
      mergedById: randomUUID(),
      unmergeUntil: new Date(Date.now() + 86_400_000)
    },
    select: { id: true }
  })
  survivorOfMerge.set(merge.id, survivor.id)
  return { id: merge.id, survivorId: survivor.id, absorbedId: absorbed.id }
}
