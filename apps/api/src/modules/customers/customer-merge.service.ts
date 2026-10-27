import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { ComplianceConfig } from '@platform/core/compliance'
import { PrismaService, type PrismaTransaction } from '@platform/core/database'
import { MergeFieldSources } from '@platform/core/domain'
import {
  resourceConflict,
  ErrorCodes,
  HttpStatusCodes,
  resourceNotFound,
  PlatformException
} from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { lockCustomerForWrite } from '@platform/core/messaging'

import type { Actor } from '../tenancy'

import { ensureDefaultAddress } from './address-default'
import type { MergeCustomersBody } from './customers.schemas'
import { type CustomerDetail, customerDetail } from './customers.views'
import {
  MERGED_FIELDS,
  type MergedField,
  type MergeSnapshot,
  mergeSnapshotSchema
} from './merge-snapshot'

const MS_PER_DAY = 86_400_000

// The fields of a customer that only make sense together
const FIELD_GROUPS: readonly (readonly MergedField[])[] = [
  ['name'],
  ['email'],
  ['phone', 'phoneNormalized'],
  ['locale'],
  ['isCaution', 'cautionReason', 'cautionSetBy', 'cautionSetAt']
]

type FieldValues = Record<string, string | boolean | null>

interface CustomerFields {
  name: string | null
  email: string | null
  phone: string | null
  phoneNormalized: string | null
  locale: string | null
  isCaution: boolean
  cautionReason: string | null
  cautionSetBy: string | null
  cautionSetAt: Date | null
}

const FIELDS_SELECT = {
  name: true,
  email: true,
  phone: true,
  phoneNormalized: true,
  locale: true,
  isCaution: true,
  cautionReason: true,
  cautionSetBy: true,
  cautionSetAt: true
} as const

const ids = (rows: { id: string }[]): string[] => rows.map(row => row.id)

function toValues(fields: CustomerFields): FieldValues {
  return Object.fromEntries(
    MERGED_FIELDS.map(field => {
      const value = fields[field]
      return [field, value instanceof Date ? value.toISOString() : value]
    })
  )
}

function fromValues(values: FieldValues, fields: readonly MergedField[]) {
  return Object.fromEntries(
    fields.map(field => {
      const value = values[field] ?? null
      return [field, field === 'cautionSetAt' && value !== null ? new Date(String(value)) : value]
    })
  )
}

// The merged customer: each contact field from the side the user chose, the other side filling a gap,
// and the caution flag of either side kept (TDD_17 §2, Customer)
function mergedFields(
  survivor: CustomerFields,
  absorbed: CustomerFields,
  choices: MergeCustomersBody['fieldChoices']
): CustomerFields {
  const pick = <K extends 'name' | 'email'>(field: K): string | null => {
    const [first, second] =
      choices[field] === MergeFieldSources.ABSORBED
        ? [absorbed[field], survivor[field]]
        : [survivor[field], absorbed[field]]
    return first ?? second
  }
  // The phone and its digits always travel together
  const [firstPhone, secondPhone] =
    choices.phone === MergeFieldSources.ABSORBED ? [absorbed, survivor] : [survivor, absorbed]
  const phoneFrom = firstPhone.phone === null ? secondPhone : firstPhone
  // Whoever is in caution gives the reason; when neither is, the survivor keeps what it had
  const cautionFrom = !survivor.isCaution && absorbed.isCaution ? absorbed : survivor
  return {
    name: pick('name'),
    email: pick('email'),
    phone: phoneFrom.phone,
    phoneNormalized: phoneFrom.phoneNormalized,
    locale: survivor.locale ?? absorbed.locale,
    isCaution: survivor.isCaution || absorbed.isCaution,
    cautionReason: cautionFrom.cautionReason,
    cautionSetBy: cautionFrom.cautionSetBy,
    cautionSetAt: cautionFrom.cautionSetAt
  }
}

// Merging two customers into one, and undoing it for 30 days (TDD_09 §6.1). The absorbed row stays,
// hidden, with `mergedIntoId` set: it is what the unmerge brings back.
@Injectable()
export class CustomerMergeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents
  ) {}

  async merge(
    storeId: string,
    survivorId: string,
    body: MergeCustomersBody,
    actor: Actor
  ): Promise<CustomerDetail> {
    if (survivorId === body.absorbedId) {
      throw new PlatformException(
        ErrorCodes.CUSTOMER_MERGE_SAME_ID,
        'a customer cannot be merged with itself',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    const mergeId = await this.prisma.transaction(async tx => {
      // In the order of their ids, so that two merges of the same pair in opposite directions
      // cannot each hold one of the rows and wait for the other
      for (const id of [survivorId, body.absorbedId].sort()) {
        await lockCustomerForWrite(tx, storeId, id)
      }
      const [survivor, absorbed] = await Promise.all([
        tx.customer.findUniqueOrThrow({ where: { id: survivorId }, select: FIELDS_SELECT }),
        tx.customer.findUniqueOrThrow({ where: { id: body.absorbedId }, select: FIELDS_SELECT })
      ])
      const after = mergedFields(survivor, absorbed, body.fieldChoices)
      const snapshot = await this.moveEverything(tx, storeId, survivorId, body, {
        survivor,
        absorbed,
        after
      })
      await tx.customer.update({ where: { id: survivorId }, data: after })
      await tx.customer.update({
        where: { id: body.absorbedId },
        data: { mergedIntoId: survivorId }
      })
      const merge = await tx.customerMerge.create({
        data: {
          storeId,
          survivorId,
          absorbedId: body.absorbedId,
          snapshot,
          mergedById: actor.userId,
          unmergeUntil: new Date(Date.now() + ComplianceConfig.UNMERGE_WINDOW_DAYS * MS_PER_DAY)
        },
        select: { id: true }
      })
      this.events.publish(tx, Events.CUSTOMER_MERGED, {
        storeId,
        survivorId,
        absorbedId: body.absorbedId
      })
      return merge.id
    })
    this.log(AuditAction.CUSTOMER_MERGED, storeId, survivorId, actor, {
      absorbedId: body.absorbedId,
      mergeId
    })
    return customerDetail(this.prisma.client, storeId, survivorId)
  }

  // Brings the absorbed customer back as it was, with what it had, and gives the survivor back what
  // the merge changed in it. What the survivor got after the merge (a note, an address) stays.
  async unmerge(
    storeId: string,
    survivorId: string,
    mergeId: string,
    actor: Actor
  ): Promise<CustomerDetail> {
    const absorbedId = await this.prisma.transaction(async tx => {
      // A survivor that was absorbed in turn cannot be locked as a customer: say what to do first
      const survivor = await tx.customer.findFirst({
        where: { id: survivorId, storeId },
        select: { mergedIntoId: true }
      })
      if (survivor === null) throw resourceNotFound('customer')
      if (survivor.mergedIntoId !== null) {
        throw resourceConflict('the customer was merged into another one: undo that merge first', {
          mergedIntoId: survivor.mergedIntoId
        })
      }
      // The survivor is locked before the merge is read, so that two undos of the same merge take
      // turns and the second one finds it already undone
      await lockCustomerForWrite(tx, storeId, survivorId)
      const merge = await tx.customerMerge.findFirst({
        where: { id: mergeId, storeId, survivorId, unmergedAt: null },
        select: { absorbedId: true, snapshot: true, unmergeUntil: true }
      })
      if (merge === null) throw resourceNotFound('merge')
      if (merge.unmergeUntil.getTime() < Date.now()) {
        throw new PlatformException(
          ErrorCodes.CUSTOMER_UNMERGE_WINDOW_EXPIRED,
          `the customers were merged more than ${ComplianceConfig.UNMERGE_WINDOW_DAYS} days ago`,
          HttpStatusCodes.CONFLICT
        )
      }
      const stillThere = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM customers
        WHERE id = ${merge.absorbedId} AND store_id = ${storeId} AND merged_into_id = ${survivorId}
        FOR UPDATE`
      if (stillThere.length === 0) {
        throw resourceConflict('the absorbed customer is no longer waiting to be restored')
      }
      const snapshot = mergeSnapshotSchema.parse(merge.snapshot)
      await this.restore(tx, storeId, survivorId, merge.absorbedId, snapshot)
      await tx.customer.update({ where: { id: merge.absorbedId }, data: { mergedIntoId: null } })
      await tx.customerMerge.update({ where: { id: mergeId }, data: { unmergedAt: new Date() } })
      this.events.publish(tx, Events.CUSTOMER_UNMERGED, {
        storeId,
        survivorId,
        absorbedId: merge.absorbedId
      })
      return merge.absorbedId
    })
    this.log(AuditAction.CUSTOMER_UNMERGED, storeId, survivorId, actor, { absorbedId, mergeId })
    return customerDetail(this.prisma.client, storeId, absorbedId)
  }

  private async moveEverything(
    tx: PrismaTransaction,
    storeId: string,
    survivorId: string,
    body: MergeCustomersBody,
    fields: { survivor: CustomerFields; absorbed: CustomerFields; after: CustomerFields }
  ): Promise<MergeSnapshot> {
    const absorbedId = body.absorbedId
    const [absorbedTags, survivorTags] = await Promise.all([
      tx.tag.findMany({
        where: { storeId, customers: { some: { id: absorbedId } } },
        select: { id: true }
      }),
      tx.tag.findMany({
        where: { storeId, customers: { some: { id: survivorId } } },
        select: { id: true }
      })
    ])
    // What is moved is what the UPDATE says it moved (RETURNING), not a list read before it: a row
    // that a webhook adds in between would otherwise move without being in the snapshot. The writers
    // of conversations and orders do not lock the customer.
    const identityIds = ids(
      await tx.$queryRaw<{ id: string }[]>`
        UPDATE customer_identities SET customer_id = ${survivorId}
        WHERE customer_id = ${absorbedId} AND store_id = ${storeId} RETURNING id`
    )
    const conversationIds = ids(
      await tx.$queryRaw<{ id: string }[]>`
        UPDATE conversations SET customer_id = ${survivorId}, updated_at = now()
        WHERE customer_id = ${absorbedId} AND store_id = ${storeId} RETURNING id`
    )
    const orderIds = ids(
      await tx.$queryRaw<{ id: string }[]>`
        UPDATE orders SET customer_id = ${survivorId}, updated_at = now()
        WHERE customer_id = ${absorbedId} AND store_id = ${storeId} RETURNING id`
    )
    const mediaIds = ids(
      await tx.$queryRaw<{ id: string }[]>`
        UPDATE media SET customer_id = ${survivorId}
        WHERE customer_id = ${absorbedId} AND store_id = ${storeId} RETURNING id`
    )
    const consentIds = ids(
      await tx.$queryRaw<{ id: string }[]>`
        UPDATE consent_records SET customer_id = ${survivorId}
        WHERE customer_id = ${absorbedId} AND store_id = ${storeId} RETURNING id`
    )
    const noteIds = ids(
      await tx.$queryRaw<{ id: string }[]>`
        UPDATE customer_notes SET customer_id = ${survivorId}
        WHERE customer_id = ${absorbedId} RETURNING id`
    )

    // One default address: the survivor's, if it has one
    const survivorHasDefault =
      (await tx.address.count({ where: { customerId: survivorId, isDefault: true } })) > 0
    const defaultedAddressIds = survivorHasDefault
      ? ids(
          await tx.$queryRaw<{ id: string }[]>`
            UPDATE addresses SET is_default = false
            WHERE customer_id = ${absorbedId} AND is_default RETURNING id`
        )
      : []
    const addressIds = ids(
      await tx.$queryRaw<{ id: string }[]>`
        UPDATE addresses SET customer_id = ${survivorId}
        WHERE customer_id = ${absorbedId} RETURNING id`
    )

    // The absorbed customer keeps its tags too: the unmerge has nothing to put back there
    await tx.customer.update({
      where: { id: survivorId },
      data: { tags: { connect: absorbedTags.map(tag => ({ id: tag.id })) } }
    })

    return {
      survivorBefore: toValues(fields.survivor),
      survivorAfter: toValues(fields.after),
      survivorTagIdsBefore: ids(survivorTags),
      absorbedTagIds: ids(absorbedTags),
      identityIds,
      conversationIds,
      orderIds,
      addressIds,
      defaultedAddressIds,
      noteIds,
      mediaIds,
      consentIds,
      fieldChoices: Object.fromEntries(
        Object.entries(body.fieldChoices).filter(([, source]) => source !== undefined)
      ) as Record<string, string>
    }
  }

  private async restore(
    tx: PrismaTransaction,
    storeId: string,
    survivorId: string,
    absorbedId: string,
    snapshot: MergeSnapshot
  ): Promise<void> {
    const back = { customerId: absorbedId }
    const fromSurvivor = (ids: string[]) => ({
      where: { id: { in: ids }, customerId: survivorId },
      data: back
    })
    const fromSurvivorInStore = (ids: string[]) => ({
      where: { id: { in: ids }, customerId: survivorId, storeId },
      data: back
    })
    // The identities still on the survivor, and with them every conversation they opened since
    const identities = await tx.customerIdentity.findMany({
      where: { id: { in: snapshot.identityIds }, customerId: survivorId },
      select: { id: true }
    })
    const identityIds = identities.map(identity => identity.id)
    await tx.customerIdentity.updateMany(fromSurvivorInStore(identityIds))
    await tx.conversation.updateMany({
      where: {
        storeId,
        customerId: survivorId,
        OR: [{ id: { in: snapshot.conversationIds } }, { customerIdentityId: { in: identityIds } }]
      },
      data: back
    })
    await tx.order.updateMany(fromSurvivorInStore(snapshot.orderIds))
    await tx.media.updateMany(fromSurvivorInStore(snapshot.mediaIds))
    await tx.consentRecord.updateMany(fromSurvivorInStore(snapshot.consentIds))
    await tx.customerNote.updateMany(fromSurvivor(snapshot.noteIds))
    await tx.address.updateMany(fromSurvivor(snapshot.addressIds))
    await tx.address.updateMany({
      where: { id: { in: snapshot.defaultedAddressIds }, customerId: absorbedId },
      data: { isDefault: true }
    })
    // The survivor may have taken another default since: the absorbed customer still gets one
    await ensureDefaultAddress(tx, absorbedId)

    const added = snapshot.absorbedTagIds.filter(id => !snapshot.survivorTagIdsBefore.includes(id))
    if (added.length > 0) {
      await tx.customer.update({
        where: { id: survivorId },
        data: { tags: { disconnect: added.map(id => ({ id })) } }
      })
    }

    // Only the fields that still hold what the merge wrote go back
    const current = await tx.customer.findUniqueOrThrow({
      where: { id: survivorId },
      select: FIELDS_SELECT
    })
    const now = toValues(current)
    // A group goes back whole or not at all: the phone with its digits, the caution flag with its
    // reason, who set it and when
    const untouched = FIELD_GROUPS.filter(
      group =>
        group.some(field => snapshot.survivorAfter[field] !== snapshot.survivorBefore[field]) &&
        group.every(field => now[field] === snapshot.survivorAfter[field])
    ).flat()
    if (untouched.length > 0) {
      await tx.customer.update({
        where: { id: survivorId },
        data: fromValues(snapshot.survivorBefore, untouched)
      })
    }
  }

  private log(
    action: typeof AuditAction.CUSTOMER_MERGED | typeof AuditAction.CUSTOMER_UNMERGED,
    storeId: string,
    survivorId: string,
    actor: Actor,
    metadata: Record<string, unknown>
  ): void {
    this.audit.log({
      action,
      actor: { userId: actor.userId },
      storeId,
      resourceType: 'customer',
      resourceId: survivorId,
      metadata,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}
