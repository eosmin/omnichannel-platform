import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import {
  isUniqueViolation,
  lockStoreForWrite,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import { type ChannelId, CustomerLimits, LOCALE_TAG_PATTERN } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

import { cleanText } from './customers.support'
import { type ParsedChannelIdentity, parseChannelIdentity } from './identity'
import { normalizePhone, type NormalizedPhone } from './phone'

// What a channel knows about the person who wrote (TDD_10 §3, ChannelEvent.channelProfile)
export interface ChannelProfile {
  displayName?: string | undefined
  locale?: string | undefined
  // What the person typed in a form (the pre-chat form of the web widget). Nobody proved it: it is
  // contact data for the team, never a reason to link the handle to another customer.
  email?: string | undefined
  phone?: string | undefined
}

// The profile once cleaned: the phone is read, and what could not be read is gone
interface CleanProfile {
  displayName?: string | undefined
  locale?: string | undefined
  email?: string | undefined
  phone?: NormalizedPhone | undefined
}

export interface FindOrCreateByIdentityInput {
  storeId: string
  channelType: ChannelId
  channelIdentity: string
  profile?: ChannelProfile | undefined
}

export interface ResolvedIdentity {
  customerId: string
  identityId: string
  created: boolean
}

// The customer behind a handle on a channel. It is the identity part of the customers: the api keeps
// the rest (lists, edits, merges), and both apps resolve a handle through this service.
@Injectable()
export class CustomerIdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents
  ) {}

  // The inbound pipeline's way in (TDD_10 §4): the customer behind a handle on a channel,
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
        HttpStatusCodes.BAD_REQUEST
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
    key: { storeId: string; channelType: ChannelId; channelIdentity: string },
    parsed: ParsedChannelIdentity,
    profile: CleanProfile
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
      // What the person typed fills a blank of their customer and never replaces a value: the
      // agents' edits, and a number or address a channel gave, stay. The condition is in the write,
      // so two events at once cannot both win.
      if (profile.email !== undefined) {
        await tx.customer.updateMany({
          where: { id: found.customerId, storeId: key.storeId, email: null },
          data: { email: profile.email }
        })
      }
      if (profile.phone !== undefined) {
        await tx.customer.updateMany({
          where: { id: found.customerId, storeId: key.storeId, phoneNormalized: null },
          data: { phone: profile.phone.display, phoneNormalized: profile.phone.digits }
        })
      }
      return { customerId: found.customerId, identityId: found.id, created: false }
    }
    const customer = await tx.customer.create({
      data: {
        storeId: key.storeId,
        name: profile.displayName ?? null,
        locale: profile.locale ?? null,
        email: profile.email ?? null,
        // The number of the handle is the channel's own; one typed in a form comes after it
        phone: (parsed.phone ?? profile.phone)?.display ?? null,
        phoneNormalized: (parsed.phone ?? profile.phone)?.digits ?? null
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
    this.events.publish(tx, Events.CUSTOMER_CREATED, {
      storeId: key.storeId,
      customerId: customer.id
    })
    this.events.publish(tx, Events.CUSTOMER_IDENTITY_LINKED, {
      storeId: key.storeId,
      customerId: customer.id,
      identityId: identity.id,
      channelType: key.channelType
    })
    return { customerId: customer.id, identityId: identity.id, created: true }
  }
}

// What a channel says about a person is not trusted as the body of a request is: it is trimmed, an
// empty value is no value, and it is cut to the size a field of the api can have
const emailSchema = z.email().max(CustomerLimits.EMAIL_MAX_LENGTH)

function cleanProfile(profile: ChannelProfile | undefined): CleanProfile {
  // A tag that is too long is not cut (a cut tag is another language): it is not a locale
  const locale = profile?.locale?.trim()
  const validLocale =
    locale !== undefined &&
    locale.length <= CustomerLimits.LOCALE_MAX_LENGTH &&
    LOCALE_TAG_PATTERN.test(locale)
  // An address or a number that is not valid is dropped, not stored half-understood
  const email = emailSchema.safeParse(profile?.email?.trim())
  const phone = profile?.phone === undefined ? null : normalizePhone(profile.phone)
  return {
    displayName: cleanText(profile?.displayName, CustomerLimits.NAME_MAX_LENGTH),
    locale: validLocale ? locale : undefined,
    email: email.success ? email.data.toLowerCase() : undefined,
    phone: phone ?? undefined
  }
}
