// The ledger of the organization is written in ONE place (TDD_18 §9.2): the posting service of libs/core/finance, which
// takes the lock on the settings, the next number and the head of the chain, keeps the balances in step and writes the
// entry and its lines in one transaction. The database holds the same rule (append-only triggers, the balanced-entry
// constraint, the privileges of the application roles), so this is the net before it. The development fixtures and the specs
// write as the owner of a database and are the other places (their blocks in eslint.config.js leave this out). Reading is free;
// so is any other model.
const FINANCE_TABLES = '(journalEntry|journalLine|accountPeriodBalance)'
const FINANCE_WRITES =
  '(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)'
const FINANCE_SQL =
  '/\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE(\\s+TABLE)?|COPY)\\s+(ONLY\\s+)?"?(public"?\\.)?"?(journal_entries|journal_lines|account_period_balances)\\b/i'
const financeWriteBans = [
  {
    selector: `CallExpression[callee.property.name=/^${FINANCE_WRITES}$/]:matches([callee.object.property.name=/^${FINANCE_TABLES}$/], [callee.object.name=/^${FINANCE_TABLES}$/])`,
    message:
      'The ledger is written only by the posting service of libs/core/finance: it keeps the number, the hash chain and the balances together'
  },
  {
    selector: `TemplateElement[value.raw=${FINANCE_SQL}]`,
    message:
      'The ledger is written only by the posting service of libs/core/finance: no SQL against journal_entries, journal_lines or account_period_balances'
  },
  {
    selector: `Literal[value=${FINANCE_SQL}]`,
    message:
      'The ledger is written only by the posting service of libs/core/finance: no SQL against journal_entries, journal_lines or account_period_balances'
  }
]

module.exports = { financeWriteBans }
