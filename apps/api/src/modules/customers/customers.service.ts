import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { lockStoreForWrite, PrismaService } from '@platform/core/database'
import {
  resourceConflict,
  ErrorCodes,
  HttpStatusCodes,
  PlatformException
} from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { customerSearchWhere, lockCustomerForWrite } from '@platform/core/messaging'

import type { Actor } from '../tenancy'

import type {
  CreateCustomerBody,
  ListCustomersQuery,
  UpdateCustomerBody
} from './customers.schemas'
import {
  type CustomerDetail,
  customerDetail,
  LIST_SELECT,
  listItem,
  type CustomerPage
} from './customers.views'
import { encodeCursor } from './list-cursor'

// The customers of the store of the request. Every query is filtered by that store (TenantGuard):
// the same phone number in two stores is two customers.
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents
  ) {}

  async list(storeId: string, query: ListCustomersQuery): Promise<CustomerPage> {
    const { cursor } = query
    const rows = await this.prisma.client.customer.findMany({
      where: {
        AND: [
          customerSearchWhere(storeId, query.q),
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
      this.events.publish(tx, Events.CUSTOMER_CREATED, { storeId, customerId: created.id })
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
        select: { name: true, email: true, phone: true, locale: true }
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
          HttpStatusCodes.BAD_REQUEST
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
      // Writing what the customer already had changes nothing: nobody is told of it
      const changed =
        (body.name !== undefined && body.name !== current.name) ||
        (body.email !== undefined && body.email !== current.email) ||
        (body.locale !== undefined && body.locale !== current.locale) ||
        (body.phone !== undefined && (body.phone?.display ?? null) !== current.phone)
      if (changed) this.events.publish(tx, Events.CUSTOMER_UPDATED, { storeId, customerId })
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
        throw resourceConflict(
          'a customer cannot be deleted while a merge into it can still be undone',
          {
            merges: undoable
          }
        )
      }
      const [conversations, orders] = await Promise.all([
        tx.conversation.count({ where: { storeId, customerId } }),
        tx.order.count({ where: { storeId, customerId } })
      ])
      if (conversations > 0 || orders > 0) {
        throw resourceConflict('a customer with conversations or orders cannot be deleted', {
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
}
