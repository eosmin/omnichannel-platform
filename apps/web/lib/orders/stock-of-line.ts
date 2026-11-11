import type { StockRules } from './order-form'

// What a line of an order form knows of its stock (see `useStockOfLines`)
export interface StockOfLine {
  // Null while it loads or when the member may not read the inventory
  rules: StockRules | null
  isLoading: boolean
  isFailed: boolean
  names: ReadonlyMap<string, string>
  // The member may read the stock and the settings, so the choice can be checked here as the server checks it
  canChoose: boolean
}
