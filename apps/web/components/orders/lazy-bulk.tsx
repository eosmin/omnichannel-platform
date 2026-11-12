import dynamic from 'next/dynamic'

// The bar over the list, its actions and the report of what they did exist only while rows are ticked. The orders page has
// a script budget (apps/web-e2e/lighthouse/budgets.ts), so none of it goes down with the page: render it only when wanted.
export const OrderBulkPanel = dynamic(
  () => import('./order-bulk-panel').then(module => module.OrderBulkPanel),
  { ssr: false }
)
