// The only files that may call `PrismaService.replicaTenantRead()` (the read of the replica that carries the tenant context) (TDD_08 §2.5). A read goes to the replica only when it tolerates
// lag: no row of it is written by the same request, nobody reads their own change through it, and no guard depends on it.
// A file is added here by a pull request that says why, and `pnpm validate:replica` fails when a file is on this list
// and no longer calls `replicaTenantRead()` (a stale entry is a hole for the next one).
//
// Left on the primary on purpose (Step 5.3, PR B): every search (messages, customers, orders, products: they apply the rules
// of erasure, deleted messages, hidden conversations and assignment, and the pickers copy a price from them) and the lists a person refreshes right after changing them (conversations,
// customers, orders, products, inventory, exports, scheduled reports, `my-performance`), because the web refetches them
// after a write and a replica that is a moment behind would show the old row. They move when there is a
// read-your-writes token (see "Left by PR B" in docs/IMPLEMENTATION_PLAN.md, Step 5.3).
export const REPLICA_READERS: readonly string[] = [
  'apps/api/src/modules/analytics/metrics-query.service.ts',
  'apps/api/src/modules/analytics/search-report.service.ts'
]
