import { Injectable } from '@nestjs/common'

import { PrismaService, type PrismaTransaction } from '@platform/core/database'
import { resourceNotFound } from '@platform/core/errors'

import { ensureDefaultAddress } from './address-default'
import type { CreateAddressBody, UpdateAddressBody } from './customers.schemas'
import { lockCustomerForWrite } from './customers.support'
import { ADDRESS_SELECT, type AddressView } from './customers.views'

// A customer has at most one default address. The customer row is locked while it is decided, so two
// requests that each make a different address the default take turns.
@Injectable()
export class AddressesService {
  constructor(private readonly prisma: PrismaService) {}

  create(storeId: string, customerId: string, body: CreateAddressBody): Promise<AddressView> {
    return this.prisma.transaction(async tx => {
      await lockCustomerForWrite(tx, storeId, customerId)
      // The first address of a customer is their default
      const isDefault =
        body.isDefault === true || (await tx.address.count({ where: { customerId } })) === 0
      if (isDefault) await clearDefault(tx, customerId)
      return tx.address.create({
        data: {
          customerId,
          line1: body.line1,
          city: body.city,
          label: body.label ?? null,
          line2: body.line2 ?? null,
          state: body.state ?? null,
          postalCode: body.postalCode ?? null,
          ...(body.country === undefined ? {} : { country: body.country }),
          isDefault
        },
        select: ADDRESS_SELECT
      })
    })
  }

  update(
    storeId: string,
    customerId: string,
    addressId: string,
    body: UpdateAddressBody
  ): Promise<AddressView> {
    return this.prisma.transaction(async tx => {
      await lockCustomerForWrite(tx, storeId, customerId)
      await this.requireAddress(tx, customerId, addressId)
      if (body.isDefault === true) await clearDefault(tx, customerId)
      const { label, line1, line2, city, state, postalCode, country, isDefault } = body
      // Field by field: nothing the schema does not name can reach the row
      await tx.address.update({
        where: { id: addressId },
        data: {
          ...(label === undefined ? {} : { label }),
          ...(line1 === undefined ? {} : { line1 }),
          ...(line2 === undefined ? {} : { line2 }),
          ...(city === undefined ? {} : { city }),
          ...(state === undefined ? {} : { state }),
          ...(postalCode === undefined ? {} : { postalCode }),
          ...(country === undefined ? {} : { country }),
          ...(isDefault === undefined ? {} : { isDefault })
        }
      })
      // Telling the default that it is not leaves the customer without one: the oldest takes over
      await ensureDefaultAddress(tx, customerId, isDefault === false ? addressId : undefined)
      return tx.address.findUniqueOrThrow({ where: { id: addressId }, select: ADDRESS_SELECT })
    })
  }

  async remove(storeId: string, customerId: string, addressId: string): Promise<void> {
    await this.prisma.transaction(async tx => {
      await lockCustomerForWrite(tx, storeId, customerId)
      await this.requireAddress(tx, customerId, addressId)
      await tx.address.delete({ where: { id: addressId } })
      // The customer keeps a default as long as they have an address
      await ensureDefaultAddress(tx, customerId)
    })
  }

  private async requireAddress(
    tx: PrismaTransaction,
    customerId: string,
    addressId: string
  ): Promise<void> {
    const address = await tx.address.findFirst({
      where: { id: addressId, customerId },
      select: { id: true }
    })
    if (address === null) throw resourceNotFound('address')
  }
}

async function clearDefault(tx: PrismaTransaction, customerId: string): Promise<void> {
  await tx.address.updateMany({
    where: { customerId, isDefault: true },
    data: { isDefault: false }
  })
}
