import type {
  AccountRole,
  AccountType,
  CashKind,
  PaymentMethod,
  TaxKind
} from '@platform/core/domain'

// A finance template is data (TDD_18 §3.1): the starter chart of a country, the role map and the account of each payment
// method. Choosing a country at setup seeds the organization once; from then on everything is the organization's own data
// and the accountant edits it. The tax rates a template seeds (Step 4B.3) name the roles whose accounts they post to, and the
// document types of the fiscal provider come with Step 4B.7.
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

export interface TemplateTaxRate {
  code: string
  // Owner's data like the names of the accounts, in the language of the country
  name: string
  // Basis points: 13 % is 1300
  rateBps: number
  kind: TaxKind
  // The roles whose mapped accounts the tax is posted to: the template's own accounts, resolved at setup
  outputRole: AccountRole
  inputRole: AccountRole
  isDefault: boolean
}

export interface FinanceTemplate {
  countryCode: string
  accounts: readonly TemplateAccount[]
  // The code of the account each role starts mapped to: every role has one, so no automatic entry starts unmappable
  roles: Readonly<Record<AccountRole, string>>
  // The account each payment method lands in (`CASH_ON_DELIVERY` is not here: it goes to the carrier receivable)
  paymentMethods: Readonly<Partial<Record<PaymentMethod, string>>>
  // The tax rates the organization starts with: exactly one is the default (TDD_18 §7)
  taxRates: readonly TemplateTaxRate[]
  // Whether the shipping fee carries the tax until the accountant says otherwise (TDD_18 §7, §13 row 2)
  shippingTaxed: boolean
}
