import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { MergeableFields } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  resourceNotFound,
  PlatformException
} from '@platform/core/errors'

export interface MergeSide {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  channels: string[]
}

export interface MergeCount {
  survivor: number
  absorbed: number
  merged: number
}

export interface MergePreview {
  survivor: MergeSide
  absorbed: MergeSide
  counts: {
    conversations: MergeCount
    notes: MergeCount
    addresses: MergeCount
    tags: MergeCount
    identities: MergeCount
  }
  // The contact fields the user chooses between: only those where both sides have a value and the
  // values differ. A field with one side empty is filled from the other by the merge.
  conflicts: (typeof MergeableFields)[number][]
}

const SIDE_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  phoneNormalized: true,
  identities: { select: { id: true, channelType: true } },
  tags: { select: { id: true } },
  _count: { select: { conversations: true, notes: true, addresses: true } }
} as const

// What a merge would do, counted before anyone confirms it (TDD_09 §6.1, step 2). Both customers are
// read inside the store of the request, so a customer of another store is one that does not exist.
@Injectable()
export class CustomerMergePreviewService {
  constructor(private readonly prisma: PrismaService) {}

  async preview(storeId: string, survivorId: string, absorbedId: string): Promise<MergePreview> {
    if (survivorId === absorbedId) {
      throw new PlatformException(
        ErrorCodes.CUSTOMER_MERGE_SAME_ID,
        'a customer cannot be merged with itself',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    const [survivor, absorbed] = await Promise.all(
      [survivorId, absorbedId].map(id =>
        this.prisma.client.customer.findFirst({
          where: { id, storeId, mergedIntoId: null },
          select: SIDE_SELECT
        })
      )
    )
    if (survivor === null || survivor === undefined) throw resourceNotFound('customer')
    if (absorbed === null || absorbed === undefined) throw resourceNotFound('customer')

    const count = (a: number, b: number, merged = a + b): MergeCount => ({
      survivor: a,
      absorbed: b,
      merged
    })
    const union = (a: { id: string }[], b: { id: string }[]) =>
      new Set([...a, ...b].map(row => row.id)).size
    const side = (row: typeof survivor): MergeSide => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      channels: [...new Set(row.identities.map(identity => identity.channelType))]
    })
    return {
      survivor: side(survivor),
      absorbed: side(absorbed),
      counts: {
        conversations: count(survivor._count.conversations, absorbed._count.conversations),
        notes: count(survivor._count.notes, absorbed._count.notes),
        addresses: count(survivor._count.addresses, absorbed._count.addresses),
        tags: count(
          survivor.tags.length,
          absorbed.tags.length,
          union(survivor.tags, absorbed.tags)
        ),
        identities: count(survivor.identities.length, absorbed.identities.length)
      },
      conflicts: MergeableFields.filter(field => {
        // The same address in another case, or the same number written another way, is no conflict
        const [first, second] =
          field === 'phone'
            ? [survivor.phoneNormalized, absorbed.phoneNormalized]
            : [survivor[field]?.toLowerCase() ?? null, absorbed[field]?.toLowerCase() ?? null]
        return first !== null && second !== null && first !== second
      })
    }
  }
}
