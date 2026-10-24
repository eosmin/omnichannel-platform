// The active store of a request. TenantGuard reads it; it is never taken from the body or the query.
export const TenantHeaders = { STORE_ID: 'x-store-id' } as const
