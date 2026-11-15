import type { AccountRole, AccountType, CashKind, PaymentMethod } from '@platform/core/domain'

// A finance template is data (TDD_18 §3.1): the starter chart of a country, the role map and the account of each payment
// method. Choosing a country at setup seeds the organization once; from then on everything is the organization's own data
// and the accountant edits it. The tax regimes of a template come with Step 4B.3 and the document types of the fiscal
// provider with Step 4B.7.
export interface TemplateAccount {
  code: string
  // The seeded names are the owner's data (like a product's name), in the language of the country: not interface copy
  name: string
  type: AccountType
  // The code of the header it sits under; null for a root
  parentCode: string | null
  isPostable: boolean
  cashKind?: CashKind
}

export interface FinanceTemplate {
  countryCode: string
  accounts: readonly TemplateAccount[]
  // The code of the account each role starts mapped to: every role has one, so no automatic entry starts unmappable
  roles: Readonly<Record<AccountRole, string>>
  // The account each payment method lands in (`CASH_ON_DELIVERY` is not here: it goes to the carrier receivable)
  paymentMethods: Readonly<Partial<Record<PaymentMethod, string>>>
}
