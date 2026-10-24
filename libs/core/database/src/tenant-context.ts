// What a unit of work may see once Row-Level Security is on (Step 7.1): the stores and the
// organizations of the caller. Both become transaction-local settings, see PrismaService.
export interface TenantContext {
  storeIds: readonly string[]
  organizationIds: readonly string[]
}
