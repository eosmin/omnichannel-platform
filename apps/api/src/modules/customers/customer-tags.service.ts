import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'

import { lockCustomerForWrite, notFound } from './customers.support'
import { TAG_SELECT, type TagView } from './customers.views'

// The tags of a customer are the tags of the store (the same ones the conversations use). Creating
// and editing the tags themselves is Step 2.3.
@Injectable()
export class CustomerTagsService {
  constructor(private readonly prisma: PrismaService) {}

  // Attaching a tag the customer already has changes nothing
  async attach(storeId: string, customerId: string, tagId: string): Promise<TagView[]> {
    // The tags are read in the same transaction: the answer is the state this request left
    return this.prisma.transaction(async tx => {
      await lockCustomerForWrite(tx, storeId, customerId)
      // A tag of another store is a tag that does not exist
      const tag = await tx.tag.findFirst({ where: { id: tagId, storeId }, select: { id: true } })
      if (tag === null) throw notFound('tag')
      const customer = await tx.customer.update({
        where: { id: customerId },
        data: { tags: { connect: { id: tagId } } },
        select: { tags: { select: TAG_SELECT, orderBy: { name: 'asc' } } }
      })
      return customer.tags
    })
  }

  async detach(storeId: string, customerId: string, tagId: string): Promise<void> {
    await this.prisma.transaction(async tx => {
      await lockCustomerForWrite(tx, storeId, customerId)
      const tag = await tx.tag.findFirst({ where: { id: tagId, storeId }, select: { id: true } })
      if (tag === null) throw notFound('tag')
      await tx.customer.update({
        where: { id: customerId },
        data: { tags: { disconnect: { id: tagId } } }
      })
    })
  }
}
