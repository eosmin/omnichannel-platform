import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type Permission, Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import { ErrorCodes, PlatformException } from '@platform/core/errors'

import type { Actor } from '../tenancy'

import type { CreateNoteBody } from './customers.schemas'
import { HTTP_FORBIDDEN, lockCustomerForWrite, notFound } from './customers.support'

export interface NoteView {
  id: string
  authorId: string
  content: string
  createdAt: Date
}

const NOTE_SELECT = { id: true, authorId: true, content: true, createdAt: true } as const

@Injectable()
export class NotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(storeId: string, customerId: string): Promise<NoteView[]> {
    const customer = await this.prisma.client.customer.findFirst({
      where: { id: customerId, storeId, mergedIntoId: null },
      select: { id: true }
    })
    if (customer === null) throw notFound('customer')
    return this.prisma.client.customerNote.findMany({
      where: { customerId },
      select: NOTE_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
  }

  create(
    storeId: string,
    customerId: string,
    authorId: string,
    body: CreateNoteBody
  ): Promise<NoteView> {
    return this.prisma.transaction(async tx => {
      await lockCustomerForWrite(tx, storeId, customerId)
      return tx.customerNote.create({
        data: { customerId, authorId, content: body.content },
        select: NOTE_SELECT
      })
    })
  }

  // Notes are the team's record about a customer: a note is deleted by who wrote it or by who may
  // delete customers, and the deletion is audited
  async remove(
    storeId: string,
    customerId: string,
    noteId: string,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<void> {
    await this.prisma.transaction(async tx => {
      await lockCustomerForWrite(tx, storeId, customerId)
      const note = await tx.customerNote.findFirst({
        where: { id: noteId, customerId },
        select: { id: true, authorId: true }
      })
      if (note === null) throw notFound('note')
      if (note.authorId !== actor.userId && !held.includes(Permissions.CUSTOMERS_DELETE)) {
        throw new PlatformException(
          ErrorCodes.PERMISSION_DENIED,
          'a note is deleted by its author or by who may delete customers',
          HTTP_FORBIDDEN
        )
      }
      await tx.customerNote.delete({ where: { id: noteId } })
    })
    this.audit.log({
      action: AuditAction.CUSTOMER_NOTE_DELETED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: 'customer',
      resourceId: customerId,
      metadata: { noteId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}
