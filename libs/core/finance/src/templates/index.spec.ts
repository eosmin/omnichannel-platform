import { financeTemplateCountries, financeTemplateFor } from './index'

// `FinanceSetupService.setup` answers 409 "set up already" to ANY unique violation of its transaction: the adapter does not expose the name of
// the constraint in a stable shape, so it cannot tell a concurrent setup from a template that repeats a code. This spec is what keeps the
// second case out of production for EVERY country that ships (a template of a later country is covered the day it is added to the list).
describe.each(financeTemplateCountries())('the finance template of %s', country => {
  const template = financeTemplateFor(country)

  it('is listed and found', () => {
    expect(template).not.toBeNull()
  })

  // The database refuses a repeat by its lowercase form too (uq_ledger_accounts_code_lower) and a second default rate
  // (tax_rates_one_default_per_organization): both end in the same 409 as a concurrent setup
  it('repeats no account code (in any case) and no tax rate code, and has exactly one default rate', () => {
    if (template === null) throw new Error('the template is listed but not found')
    const accountCodes = template.accounts.map(account => account.code.toLowerCase())
    expect(new Set(accountCodes).size).toBe(accountCodes.length)
    const rateCodes = template.taxRates.map(rate => rate.code)
    expect(new Set(rateCodes).size).toBe(rateCodes.length)
    expect(template.taxRates.filter(rate => rate.isDefault)).toHaveLength(1)
  })
})
