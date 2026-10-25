import { createHash } from 'node:crypto'

// What a log line carries instead of an address (customer data stays out of the logs)
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16)
}
