// Fails when a queue.add / addBulk of apps/api or libs is not inside PrismaService.afterCommitStep and its file is not listed.
// Usage: tsx scripts/validate-enqueue-after-commit.ts
import { exit } from 'node:process'

import { checkQueueAddsAfterCommit } from './lib/static-guards'

const { scanned, failures } = checkQueueAddsAfterCommit(process.cwd())
if (failures.length > 0) {
  console.error('A job is queued where the transaction of the request may not have committed:')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error(
    'Write it as `await this.prisma.afterCommitStep(this.prisma.client, () => this.queue.add(...))`: the step runs after the real COMMIT and its failure still reaches the caller.'
  )
  exit(1)
}
console.log(
  `enqueue-after-commit: ${scanned} files scanned, every queue.add is after the commit or listed`
)
