import { z } from 'zod'

import type { PrismaTransaction } from '@platform/core/database'
import {
  AuthorType,
  MessageType,
  OrderLineLimits,
  OrderStatus,
  OrderSummaryEvents,
  uuidSchema
} from '@platform/core/domain'

// What an ORDER_SUMMARY line of the thread keeps of an order: a pointer (the id and the number) and the
// figures the card shows without opening it. It carries NO text of its own, and never a note, an address
// or a phone: the thread draws it in the language of who reads it, and the customer's notes, the
// internal notes and the packing notes of the order stay on the order. Every key is there, null when it
// does not apply (`previousStatus` is null on the line of a creation).
export const orderSummaryLineSchema = z.strictObject({
  event: z.enum(OrderSummaryEvents),
  orderId: uuidSchema,
  orderNumber: z.string().min(1).max(OrderLineLimits.NUMBER_MAX_LENGTH),
  status: z.enum(OrderStatus),
  previousStatus: z.enum(OrderStatus).nullable(),
  totalCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  itemCount: z.number().int().nonnegative(),
  // Who did it: a person, or the system
  actor: z.strictObject({ type: z.enum(['user', 'system']), id: uuidSchema.nullable() })
})
export type OrderSummaryLine = z.output<typeof orderSummaryLineSchema>
export type OrderSummaryLineInput = Omit<OrderSummaryLine, 'previousStatus'> &
  Partial<Pick<OrderSummaryLine, 'previousStatus'>>

// Written in the transaction of the order's change, so the thread and the order never disagree, by the
// OrdersService when it creates an order or changes its status for an order that came from a conversation
// (`Order.conversationId`). Like a system line it does not touch the conversation: it is not the last
// message, does not move `lastMessageAt` and does not raise `unreadCount`, and it is never sent to the
// customer (sending the summary is Step 4.9). The metadata is validated before it is written, so a caller
// cannot store a shape that the thread would refuse to read. It answers false when the conversation is not
// one of the store (the line is not written): the caller decides if that deserves a log, the order's change
// does not depend on it.
export async function writeOrderSummaryLine(
  tx: PrismaTransaction,
  storeId: string,
  conversationId: string,
  line: OrderSummaryLineInput
): Promise<boolean> {
  // `previousStatus` is defaulted after the spread: an explicit undefined must not override the null
  const metadata = orderSummaryLineSchema.parse({
    ...line,
    previousStatus: line.previousStatus ?? null
  })
  // The conversation must be one of this store: an id from a caller is never trusted for the tenant
  const conversation = await tx.conversation.findFirst({
    where: { id: conversationId, storeId },
    select: { id: true }
  })
  if (conversation === null) return false
  await tx.message.create({
    data: {
      storeId,
      conversationId,
      type: MessageType.ORDER_SUMMARY,
      authorType: AuthorType.SYSTEM,
      content: null,
      metadata
    }
  })
  return true
}
