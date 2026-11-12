import { dateToCalendarDay } from '@platform/core/domain'
import { nationalPhoneNumber } from '@platform/core/messaging'

// What an order looks like on the way out. Money is whole USD cents. The two internal notes are read by the members who
// may read orders only, and never by the customer, a channel, a plugin or the label of a carrier (TDD_17 §8): the detail
// builds them in only when the caller may, the list and the events never carry them.

export const ORDER_LIST_SELECT = {
  id: true,
  orderNumber: true,
  customerId: true,
  status: true,
  subtotalCents: true,
  shippingCents: true,
  discountCents: true,
  totalCents: true,
  currency: true,
  paymentMethod: true,
  paymentStatus: true,
  priceApprovalStatus: true,
  freeShipping: true,
  scheduledDeliveryDate: true,
  // The planned carrier (the column of the list)
  carrierConnectionId: true,
  createdAt: true,
  updatedAt: true,
  // Who made the order, for the column of the list: the name only (the contact data is in the detail)
  customer: { select: { id: true, name: true, isCaution: true } },
  // The "price modified" badge of the list: one row is enough to know
  items: { where: { originalUnitPriceCents: { not: null } }, select: { id: true }, take: 1 }
} as const

export const ORDER_DETAIL_SELECT = {
  id: true,
  orderNumber: true,
  customerId: true,
  conversationId: true,
  status: true,
  subtotalCents: true,
  shippingCents: true,
  discountCents: true,
  totalCents: true,
  currency: true,
  paymentMethod: true,
  paymentStatus: true,
  paymentReference: true,
  paymentProofMediaId: true,
  shippingAddress: true,
  customerNotes: true,
  internalNotes: true,
  packingNotes: true,
  recipientPhones: true,
  scheduledDeliveryDate: true,
  trackingNumber: true,
  cancellationReason: true,
  cancelledBy: true,
  cancelledAt: true,
  proofOfDeliveryMediaId: true,
  confirmedAt: true,
  confirmedBy: true,
  confirmedVia: true,
  copiedFromOrderId: true,
  freeShipping: true,
  discountReason: true,
  priceApprovalStatus: true,
  priceApprovalRequestedBy: true,
  priceApprovedBy: true,
  priceApprovedAt: true,
  priceApprovedDiscountCents: true,
  priceApprovedShippingCents: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  shippedAt: true,
  deliveredAt: true,
  customer: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      phoneNormalized: true,
      isCaution: true
    }
  },
  items: {
    select: {
      id: true,
      productId: true,
      variantId: true,
      productName: true,
      variantName: true,
      quantity: true,
      unitPriceCents: true,
      originalUnitPriceCents: true,
      priceOverrideReason: true,
      priceOverriddenBy: true,
      freeShipping: true,
      allocations: {
        select: { warehouseId: true, quantity: true },
        orderBy: { createdAt: 'asc' }
      }
    },
    orderBy: { id: 'asc' }
  }
} as const

// The shapes the two selects above read, written out: the Prisma namespace is not exported to the api
interface ListRow {
  id: string
  orderNumber: string
  customerId: string
  status: string
  subtotalCents: number
  shippingCents: number
  discountCents: number
  totalCents: number
  currency: string
  paymentMethod: string
  paymentStatus: string
  priceApprovalStatus: string
  freeShipping: boolean
  scheduledDeliveryDate: Date | null
  carrierConnectionId: string | null
  createdAt: Date
  updatedAt: Date
  customer: { id: string; name: string | null; isCaution: boolean }
  items: { id: string }[]
}

interface DetailRow extends Omit<ListRow, 'items' | 'carrierConnectionId'> {
  conversationId: string | null
  paymentReference: string | null
  paymentProofMediaId: string | null
  shippingAddress: unknown
  customerNotes: string | null
  internalNotes: string | null
  packingNotes: string | null
  recipientPhones: string[] | null
  trackingNumber: string | null
  cancellationReason: string | null
  cancelledBy: string | null
  cancelledAt: Date | null
  proofOfDeliveryMediaId: string | null
  confirmedAt: Date | null
  confirmedBy: string | null
  confirmedVia: string | null
  copiedFromOrderId: string | null
  discountReason: string | null
  priceApprovalRequestedBy: string | null
  priceApprovedBy: string | null
  priceApprovedAt: Date | null
  priceApprovedDiscountCents: number | null
  priceApprovedShippingCents: number | null
  createdBy: string
  shippedAt: Date | null
  deliveredAt: Date | null
  customer: {
    id: string
    name: string | null
    email: string | null
    phone: string | null
    phoneNormalized: string | null
    isCaution: boolean
  }
  items: OrderItemView[]
}

export interface OrderSummaryView extends Omit<ListRow, 'items' | 'scheduledDeliveryDate'> {
  scheduledDeliveryDate: string | null
  priceModified: boolean
}

export interface OrderItemView {
  id: string
  productId: string
  variantId: string | null
  productName: string
  variantName: string | null
  quantity: number
  unitPriceCents: number
  originalUnitPriceCents: number | null
  priceOverrideReason: string | null
  priceOverriddenBy: string | null
  freeShipping: boolean
  allocations: { warehouseId: string; quantity: number }[]
}

export interface OrderCustomerView {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  // The phone without its country code, for the recipient phones of the form: the web never parses a phone
  nationalPhone: string | null
  // The caution flag informs and never blocks (TDD_17 §4.16). Null: the caller may not read the contact data of the
  // customer, so the flag is not known to them (not `false`). The reason is not here: it is free text about a person
  // and is read in the customer detail, behind `customers:view`.
  isCaution: boolean | null
}

export interface OrderDetailView extends Omit<
  DetailRow,
  | 'items'
  | 'customer'
  | 'scheduledDeliveryDate'
  | 'recipientPhones'
  | 'internalNotes'
  | 'packingNotes'
> {
  scheduledDeliveryDate: string | null
  recipientPhones: string[]
  // Left out (not null) for a caller who may not read orders
  internalNotes?: string | null
  packingNotes?: string | null
  customer: OrderCustomerView
  items: OrderItemView[]
  priceModified: boolean
}

export interface OrderPage {
  data: OrderSummaryView[]
  nextCursor: string | null
  hasMore: boolean
}

export function summaryView({ items, scheduledDeliveryDate, ...order }: ListRow): OrderSummaryView {
  return {
    ...order,
    scheduledDeliveryDate:
      scheduledDeliveryDate === null ? null : dateToCalendarDay(scheduledDeliveryDate),
    priceModified: items.length > 0
  }
}

// `canRead` is orders:view. A mutating route answers with the order too, to members who may not read orders (a creator, an
// editor): they get what they need to go on (numbers, status, lines, totals) and none of what the read route protects:
// the contact data of the customer, the address, the phones, the payment reference and the three notes.
export function detailView(row: DetailRow, canRead: boolean): OrderDetailView {
  const {
    customer,
    items,
    scheduledDeliveryDate,
    recipientPhones,
    internalNotes,
    packingNotes,
    ...order
  } = row
  if (!canRead) {
    return {
      ...order,
      customerNotes: null,
      trackingNumber: null,
      confirmedBy: null,
      cancelledBy: null,
      priceApprovalRequestedBy: null,
      priceApprovedBy: null,
      shippingAddress: null,
      paymentReference: null,
      paymentProofMediaId: null,
      proofOfDeliveryMediaId: null,
      conversationId: null,
      copiedFromOrderId: null,
      discountReason: null,
      cancellationReason: null,
      recipientPhones: [],
      scheduledDeliveryDate:
        scheduledDeliveryDate === null ? null : dateToCalendarDay(scheduledDeliveryDate),
      customer: {
        id: customer.id,
        name: null,
        email: null,
        phone: null,
        nationalPhone: null,
        isCaution: null
      },
      items: items.map(item => ({
        ...item,
        priceOverrideReason: null,
        priceOverriddenBy: null
      })),
      priceModified: items.some(item => item.originalUnitPriceCents !== null)
    }
  }
  return {
    ...order,
    // A column that is null is read as no phones: an order of an older shape is read, not refused
    recipientPhones: recipientPhones ?? [],
    scheduledDeliveryDate:
      scheduledDeliveryDate === null ? null : dateToCalendarDay(scheduledDeliveryDate),
    internalNotes,
    packingNotes,
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      nationalPhone:
        customer.phoneNormalized === null ? null : nationalPhoneNumber(customer.phoneNormalized),
      isCaution: customer.isCaution
    },
    items: items.map(item => ({ ...item })),
    priceModified: items.some(item => item.originalUnitPriceCents !== null)
  }
}
