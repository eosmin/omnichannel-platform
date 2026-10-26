import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  isUniqueViolation,
  lockStoreForWrite,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import { ChannelType, CustomerLimits, LOCALE_TAG_PATTERN } from '@platform/core/domain'
import { ErrorCodes, PlatformException } from '@platform/core/errors'

import type { Actor } from '../tenancy'

import type {
  CreateCustomerBody,
  ListCustomersQuery,
  UpdateCustomerBody
} from './customers.schemas'
import {
  cleanText,
  conflict,
  escapeLike,
  HTTP_BAD_REQUEST,
  lockCustomerForWrite
} from './customers.support'
import {
  type CustomerDetail,
  customerDetail,
  LIST_SELECT,
  listItem,
  type CustomerPage
} from './customers.views'
import { type ParsedChannelIdentity, parseChannelIdentity } from './identity'
import { encodeCursor } from './list-cursor'

// What a channel knows about the person who wrote (TDD_10 §3, ChannelEvent.channelProfile)
export interface ChannelProfile {
  displayName?: string | undefined
  locale?: string | undefined
}

export interface FindOrCreateByIdentityInput {
  storeId: string
  channelType: ChannelType
  channelIdentity: string
  profile?: ChannelProfile | undefined
}

export interface ResolvedIdentity {
  customerId: string
  identityId: string
  created: boolean
}

// Digits, spaces and the punctuation a phone number is written with, and at least three digits
const PHONE_LIKE = /^(?=(?:\D*\d){3})[\d\s+().-]+$/

// The customers of the store of the request. Every query is filtered by that store (TenantGuard):
// the same phone number in two stores is two customers.
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(storeId: string, query: ListCustomersQuery): Promise<CustomerPage> {
    const text = query.q === undefined ? null : escapeLike(query.q)
    // "Calle 123" is a street and "7123-4567" a phone: the digits are looked for in the phones only
    // when nothing but digits and the punctuation of a phone was typed
    const digits =
      query.q !== undefined && PHONE_LIKE.test(query.q) ? query.q.replace(/\D/g, '') : ''
    const { cursor } = query
    const rows = await this.prisma.client.customer.findMany({
      where: {
        storeId,
        mergedIntoId: null,
        AND: [
          text === null
            ? {}
            : {
                OR: [
                  { name: { contains: text, mode: 'insensitive' } },
                  { email: { contains: text, mode: 'insensitive' } },
                  ...(digits === '' ? [] : [{ phoneNormalized: { contains: digits } }])
                ]
              },
          // After the last row of the previous page in (createdAt, id) order, wherever that row is now
          cursor === undefined
            ? {}
            : {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } }
                ]
              }
        ]
      },
      select: LIST_SELECT,
      take: query.limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(listItem),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  get(storeId: string, customerId: string): Promise<CustomerDetail> {
    return customerDetail(this.prisma.client, storeId, customerId)
  }

  async create(storeId: string, body: CreateCustomerBody): Promise<CustomerDetail> {
    const id = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const created = await tx.customer.create({
        data: {
          storeId,
          name: body.name ?? null,
          email: body.email ?? null,
          phone: body.phone?.display ?? null,
          phoneNormalized: body.phone?.digits ?? null,
          locale: body.locale ?? null
        },
        select: { id: true }
      })
      return created.id
    })
    return this.get(storeId, id)
  }

  async update(
    storeId: string,
    customerId: string,
    body: UpdateCustomerBody
  ): Promise<CustomerDetail> {
    await this.prisma.transaction(async tx => {
      await lockCustomerForWrite(tx, storeId, customerId)
      // A customer keeps a way to be named or reached, as when it was created
      const current = await tx.customer.findUniqueOrThrow({
        where: { id: customerId },
        select: { name: true, email: true, phone: true }
      })
      const left = {
        name: body.name === undefined ? current.name : body.name,
        email: body.email === undefined ? current.email : body.email,
        phone: body.phone === undefined ? current.phone : (body.phone?.display ?? null)
      }
      if (left.name === null && left.email === null && left.phone === null) {
        throw new PlatformException(
          ErrorCodes.VALIDATION_FAILED,
          'a customer needs a name, an e-mail address or a phone number',
          HTTP_BAD_REQUEST
        )
      }
      await tx.customer.update({
        where: { id: customerId },
        data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.email === undefined ? {} : { email: body.email }),
          ...(body.locale === undefined ? {} : { locale: body.locale }),
          ...(body.phone === undefined
            ? {}
            : {
                phone: body.phone?.display ?? null,
                phoneNormalized: body.phone?.digits ?? null
              })
        }
      })
    })
    return this.get(storeId, customerId)
  }

  // A customer with conversations or orders is part of the history of the store and stays: the
  // erasure of personal data (Step 7.2) is the way to take a person out of it.
  async remove(storeId: string, customerId: string, actor: Actor): Promise<void> {
    await this.prisma.transaction(async tx => {
      await lockCustomerForWrite(tx, storeId, customerId)
      // The survivor of a merge that can still be undone is what brings the absorbed customer back:
      // without it that customer would stay hidden. Once the time to undo has passed, nothing needs it.
      const undoable = await tx.customerMerge.count({
        where: {
          storeId,
          survivorId: customerId,
          unmergedAt: null,
          unmergeUntil: { gt: new Date() }
        }
      })
      if (undoable > 0) {
        throw conflict('a customer cannot be deleted while a merge into it can still be undone', {
          merges: undoable
        })
      }
      const [conversations, orders] = await Promise.all([
        tx.conversation.count({ where: { storeId, customerId } }),
        tx.order.count({ where: { storeId, customerId } })
      ])
      if (conversations > 0 || orders > 0) {
        throw conflict('a customer with conversations or orders cannot be deleted', {
          conversations,
          orders
        })
      }
      await tx.customer.delete({ where: { id: customerId } })
    })
    this.audit.log({
      action: AuditAction.CUSTOMER_DELETED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: 'customer',
      resourceId: customerId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }

  // The inbound pipeline's way in (Step 2.6, TDD_10 §4): the customer behind a handle on a channel,
  // created with it the first time the handle writes. Two events for a new handle at the same moment
  // end in one customer: the unique index of (store, channel, handle) decides, and the one that
  // loses reads what the winner wrote. That read needs a transaction of its own: called from inside
  // another one, the failed insert would have aborted it.
  async findOrCreateByIdentity(input: FindOrCreateByIdentityInput): Promise<ResolvedIdentity> {
    const parsed = parseChannelIdentity(input.channelType, input.channelIdentity, {
      fromChannel: true
    })
    if (parsed === null) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_INVALID_INPUT,
        `not a valid ${input.channelType} handle`,
        HTTP_BAD_REQUEST
      )
    }
    const key = {
      storeId: input.storeId,
      channelType: input.channelType,
      channelIdentity: parsed.identity
    }
    const profile = cleanProfile(input.profile)
    try {
      return await this.prisma.transaction(tx => this.resolve(tx, key, parsed, profile))
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      // The handle was created by an event that was faster: run again, now it is found (and the
      // profile of this event is applied to it). If it is something else that conflicts, it fails again.
      return this.prisma.transaction(tx => this.resolve(tx, key, parsed, profile))
    }
  }

  private async resolve(
    tx: PrismaTransaction,
    key: { storeId: string; channelType: ChannelType; channelIdentity: string },
    parsed: ParsedChannelIdentity,
    profile: ChannelProfile
  ): Promise<ResolvedIdentity> {
    // Before anything is read: a delete of the store waits for this, and a store that is gone is
    // found as such
    await lockStoreForWrite(tx, key.storeId)
    const first = await tx.customerIdentity.findFirst({
      where: key,
      select: { id: true, customerId: true }
    })
    // A merge that is moving the identity holds the customer: wait for it, and read again who has
    // the identity once it is done
    if (first !== null) {
      await tx.$queryRaw`SELECT id FROM customers WHERE id = ${first.customerId} FOR SHARE`
    }
    const found =
      first === null
        ? null
        : await tx.customerIdentity.findFirst({
            where: key,
            select: { id: true, customerId: true, displayName: true }
          })
    if (found !== null) {
      // The name the channel reports may change; the customer's own name is the agents'
      if (profile.displayName !== undefined && profile.displayName !== found.displayName) {
        await tx.customerIdentity.update({
          where: { id: found.id },
          data: { displayName: profile.displayName }
        })
      }
      return { customerId: found.customerId, identityId: found.id, created: false }
    }
    const customer = await tx.customer.create({
      data: {
        storeId: key.storeId,
        name: profile.displayName ?? null,
        locale: profile.locale ?? null,
        phone: parsed.phone?.display ?? null,
        phoneNormalized: parsed.phone?.digits ?? null,
        email: parsed.email ?? null
      },
      select: { id: true }
    })
    const identity = await tx.customerIdentity.create({
      data: {
        storeId: key.storeId,
        customerId: customer.id,
        channelType: key.channelType,
        channelIdentity: key.channelIdentity,
        displayName: profile.displayName ?? null
      },
      select: { id: true }
    })
    return { customerId: customer.id, identityId: identity.id, created: true }
  }
}

// What a channel says about a person is not trusted as the body of a request is: it is trimmed, an
// empty value is no value, and it is cut to the size a field of the api can have
function cleanProfile(profile: ChannelProfile | undefined): ChannelProfile {
  // A tag that is too long is not cut (a cut tag is another language): it is not a locale
  const locale = profile?.locale?.trim()
  const validLocale =
    locale !== undefined &&
    locale.length <= CustomerLimits.LOCALE_MAX_LENGTH &&
    LOCALE_TAG_PATTERN.test(locale)
  return {
    displayName: cleanText(profile?.displayName, CustomerLimits.NAME_MAX_LENGTH),
    locale: validLocale ? locale : undefined
  }
}
