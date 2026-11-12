import dynamic from 'next/dynamic'

// The bar over the list and the report of what it did exist only while rows are ticked or an action has an answer. The orders
// page has a script budget (apps/web-e2e/lighthouse/budgets.ts), so neither goes down with the page: render each one only
// when it is wanted.
export const OrderBulkBar = dynamic(
  () => import('./order-bulk-bar').then(module => module.OrderBulkBar),
  { ssr: false }
)

export const OrderBulkReport = dynamic(
  () => import('./order-bulk-report').then(module => module.OrderBulkReport),
  { ssr: false }
)
