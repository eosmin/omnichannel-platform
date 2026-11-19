import { Injectable } from '@nestjs/common'

import { PrismaService, type TenantContext } from '@platform/core/database'

// The store a public widget call acts for, as the lookup of its site key found it (never a value the visitor sent)
export interface WidgetTenantSite {
  storeId: string
  organizationId: string
}

// The context of the store of a widget site: that store and its organization, and nothing else
export function widgetContextOf(site: WidgetTenantSite): TenantContext {
  return { storeIds: [site.storeId], organizationIds: [site.organizationId] }
}

// The public routes and the socket of the widget have no TenantGuard and no X-Store-Id: the visitor is anonymous and the site key
// is the only thing they hold. Once WidgetSites has found the store, everything the call reads of the store (the history, the
// hours, the files) runs inside THIS context. It joins a context that is already open (a bootstrap reads three things in one
// transaction) as long as it is the context of the same store alone; it never widens one.
@Injectable()
export class WidgetTenant {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(site: WidgetTenantSite, work: () => Promise<T>): Promise<T> {
    const current = this.prisma.currentTenantContext()
    if (current === undefined) return this.prisma.tenantTransaction(widgetContextOf(site), work)
    if (
      current.storeIds.length !== 1 ||
      current.storeIds[0] !== site.storeId ||
      current.organizationIds.length !== 1 ||
      current.organizationIds[0] !== site.organizationId
    ) {
      throw new Error(
        'a widget call runs in the context of the store of its site and its organization, and of those alone'
      )
    }
    return work()
  }
}
