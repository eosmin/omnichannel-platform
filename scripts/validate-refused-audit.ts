// Fails when AuditService.logRefused (denials only: it survives the rollback of the request) is used outside the listed files.
// Usage: tsx scripts/validate-refused-audit.ts
import { exit } from 'node:process'

import { checkRefusedAudit } from './lib/static-guards'

const { scanned, failures } = checkRefusedAudit(process.cwd())
if (failures.length > 0) {
  console.error('AuditService.logRefused used outside the plugin denial audit:')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error(
    'A success goes through AuditService.log, which commits or rolls back with its request.'
  )
  exit(1)
}
console.log(`refused-audit: ${scanned} files scanned, logRefused used only where listed`)
