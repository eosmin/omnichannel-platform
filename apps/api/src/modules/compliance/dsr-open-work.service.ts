import { Injectable } from '@nestjs/common'

import { type DsrOpenWork, DsrOpenWorkStatuses } from '@platform/core/compliance'
import type { PrismaTransaction } from '@platform/core/database'
import { RemittanceStatus } from '@platform/core/domain'

// The work of the store that still points to the customers of a data request (TDD_05 §10.3): an erasure waits for it. Every count is
// filtered by the store of the request and by the customers the request names; it answers numbers, never a row.
@Injectable()
export class DsrOpenWorkService {
  async countOf(
    tx: PrismaTransaction,
    storeId: string,
    customerIds: readonly string[]
  ): Promise<DsrOpenWork> {
    if (customerIds.length === 0) {
      return { orders: 0, shipments: 0, returns: 0, remittances: 0, receivables: 0 }
    }
    const ofCustomer = { storeId, customerId: { in: [...customerIds] } }
    const ofOrder = { storeId, order: { is: ofCustomer } }
    const [orders, shipments, returns, remittances, unpaid, codOwed] = await Promise.all([
      tx.order.count({ where: { ...ofCustomer, status: { in: [...DsrOpenWorkStatuses.ORDERS] } } }),
      tx.shipment.count({
        where: { ...ofOrder, status: { notIn: [...DsrOpenWorkStatuses.SHIPMENTS_ENDED] } }
      }),
      tx.orderReturn.count({
        where: { ...ofOrder, status: { in: [...DsrOpenWorkStatuses.RETURNS] } }
      }),
      // The lines of a remittance that is still a draft and that name a guide of these customers
      tx.codRemittanceLine.count({
        where: {
          storeId,
          remittance: { is: { status: RemittanceStatus.DRAFT } },
          shipment: { is: ofOrder }
        }
      }),
      tx.order.count({
        where: {
          ...ofCustomer,
          status: DsrOpenWorkStatuses.UNPAID_ORDER,
          paymentStatus: DsrOpenWorkStatuses.UNPAID_PAYMENT
        }
      }),
      tx.shipment.count({
        where: { ...ofOrder, codStatus: { in: [...DsrOpenWorkStatuses.COD_OWED] } }
      })
    ])
    return { orders, shipments, returns, remittances, receivables: unpaid + codOwed }
  }
}
