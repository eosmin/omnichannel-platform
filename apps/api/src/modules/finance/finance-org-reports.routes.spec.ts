import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The reports that read the orders of EVERY store of the organization (VAT, margin, the books of sales, and the aging that names the carrier connections of every store) must not run in the one transaction
// of the request: with Row-Level Security on it holds the store of the header alone, and the report would change with the header. They open
// the context of the organization themselves (`JobContext.inOrganization`, in the service), so each route says it is @NoTenantTransaction.
// The routes that only write or read the books (not the orders) stay in the context of the request. Read from the source, as the spec of
// `@TenantOfOrganizationStores` does: importing the controllers would load the environment.
const MARK = '@NoTenantTransaction('
const routes: [string, string, string][] = [
  ['vat report', 'finance.controller.ts', 'vat'],
  ['vat csv', 'finance.controller.ts', 'vatCsv'],
  ['margin report', 'finance-margin.controller.ts', 'report'],
  ['margin csv', 'finance-margin.controller.ts', 'csv'],
  ['book of a kind', 'finance-books.controller.ts', 'book'],
  ['book csv', 'finance-books.controller.ts', 'bookCsv'],
  ['aging', 'finance-statements.controller.ts', 'aging'],
  ['aging csv', 'finance-statements.controller.ts', 'agingCsv']
]
const notRoutes: [string, string, string][] = [
  ['book layouts', 'finance-books.controller.ts', 'layouts'],
  ['write a layout', 'finance-books.controller.ts', 'writeLayout'],
  ['frozen books', 'finance-books.controller.ts', 'frozen'],
  ['income statement', 'finance-statements.controller.ts', 'incomeStatement']
]

// The decorators of a handler: the lines that stand right above its name (decorators, their arguments and comments), read upwards until
// the first line that is none of them
function decoratorsOf(file: string, handler: string): string {
  const lines = readFileSync(join(__dirname, file), 'utf8').split('\n')
  const at = lines.findIndex(line => new RegExp(`^  (async )?${handler}\\(`).test(line))
  expect(at).toBeGreaterThan(-1)
  const found: string[] = []
  for (let index = at - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? ''
    if (!/^( {2}@| {4}| {2}\)| {2}\/\/)/.test(line)) break
    found.push(line)
  }
  return found.join('\n')
}

// The services read inside the unit of the organization: the route does not open one, so a service that forgot would read nothing with RLS on
const services: [string, string][] = [
  ['finance-vat-report.service.ts', 'readReport'],
  ['finance-vat-report.service.ts', 'readCsv'],
  ['finance-margin.service.ts', 'readMargin'],
  ['finance-margin.service.ts', 'readMarginCsvRows'],
  ['finance-books.service.ts', 'readBook'],
  ['finance-books.service.ts', 'readCsv'],
  ['finance-statements.service.ts', 'readAging'],
  ['finance-statements.service.ts', 'readAgingCsvRows']
]

describe('the reports of the books that read the orders of the organization', () => {
  it.each(routes)('%s opens its own context of the organization', (_name, file, handler) => {
    expect(decoratorsOf(file, handler)).toContain(MARK)
  })

  it.each(notRoutes)('%s stays in the context of the request', (_name, file, handler) => {
    expect(decoratorsOf(file, handler)).not.toContain(MARK)
  })

  it.each(services)('%s runs %s inside the unit of the organization', (file, inner) => {
    const text = readFileSync(join(__dirname, file), 'utf8')
    expect(text).toMatch(
      new RegExp(
        `jobContext\\.inOrganization\\(\\s*organizationId,\\s*\\(\\)\\s*=>\\s*this\\.${inner}\\(`
      )
    )
  })
})
