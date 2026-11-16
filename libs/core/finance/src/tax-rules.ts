// The tax rules are pure and a screen uses them too, so they live in the domain lib; this file keeps the old path of the services.
export {
  allocateByWeight,
  computeOrderTax,
  isRateBps,
  resolveLineTax,
  roundedQuotient,
  taxOfAmount
} from '@platform/core/domain'
export type { OrderTax, TaxableLine, TaxedLine, TaxInput } from '@platform/core/domain'
