import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import type { Refusal } from './movement-math'

// What the engine answers when it refuses (TDD_16 §3). The messages are English and go to the logs; the client reads
// the code and the metadata.

export function stockRefused(
  refusal: Refusal,
  context: { warehouseId: string; requested: number }
): PlatformException {
  const { warehouseId, requested } = context
  switch (refusal.kind) {
    case 'insufficient_available':
      return new PlatformException(
        ErrorCodes.INSUFFICIENT_INVENTORY,
        'not enough available stock in the warehouse',
        HttpStatusCodes.CONFLICT,
        { warehouseId, requested, available: refusal.available }
      )
    case 'insufficient_on_hand':
      return new PlatformException(
        ErrorCodes.INSUFFICIENT_INVENTORY,
        'not enough stock on hand in the warehouse',
        HttpStatusCodes.CONFLICT,
        { warehouseId, requested, onHand: refusal.onHand }
      )
    case 'reservation_exceeded':
      return new PlatformException(
        ErrorCodes.INVENTORY_RESERVATION_EXCEEDED,
        'more units than are reserved in the warehouse',
        HttpStatusCodes.CONFLICT,
        { warehouseId, requested, reserved: refusal.reserved }
      )
  }
}

export const warehouseNotLinked = (warehouseId: string): PlatformException =>
  new PlatformException(
    ErrorCodes.INVENTORY_WAREHOUSE_NOT_LINKED,
    'the store does not sell from this warehouse',
    HttpStatusCodes.CONFLICT,
    { warehouseId }
  )

export const warehouseInactive = (warehouseId: string): PlatformException =>
  new PlatformException(
    ErrorCodes.INVENTORY_WAREHOUSE_INACTIVE,
    'the warehouse is switched off',
    HttpStatusCodes.CONFLICT,
    { warehouseId }
  )

export const productNotTracked = (productId: string): PlatformException =>
  new PlatformException(
    ErrorCodes.INVENTORY_PRODUCT_NOT_TRACKED,
    'the product does not track inventory',
    HttpStatusCodes.CONFLICT,
    { productId }
  )

export const reasonRequired = (message: string): PlatformException =>
  new PlatformException(
    ErrorCodes.INVENTORY_ADJUSTMENT_REASON_REQUIRED,
    message,
    HttpStatusCodes.BAD_REQUEST
  )

export const invalidMovement = (message: string): PlatformException =>
  new PlatformException(ErrorCodes.VALIDATION_FAILED, message, HttpStatusCodes.BAD_REQUEST)

export const variantRequired = (productId: string): PlatformException =>
  new PlatformException(
    ErrorCodes.INVENTORY_VARIANT_REQUIRED,
    'the product has variants: name the one the stock is of',
    HttpStatusCodes.CONFLICT,
    { productId }
  )
