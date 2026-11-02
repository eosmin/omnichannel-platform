import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MagicLinkThrottle } from '@platform/core/auth'

// The api allows `MagicLinkThrottle.limit` links a minute per address, whatever the IP, and the specs
// share a handful of addresses (admin@, agent@). A spec file added or sped up can push one address
// over the limit and make the next spec wait for an email that never comes. Every request for a link
// goes through here: it waits until the address has room in a sliding window a little wider than the
// api's, and spends no time when there is room. The stamps live in a file because Playwright starts
// a new worker after a failed test and a module variable would be lost with it; the global setup
// empties it at the start of a run.
const STAMPS_FILE = join(tmpdir(), 'platform-e2e-magic-link-stamps.json')
const WINDOW_MS = MagicLinkThrottle.ttlMs + 2_000
const POLL_MS = 500
// A wait this long means the budget is stuck, not busy: say so instead of a bare test timeout
const MAX_WAIT_MS = WINDOW_MS * 2
// One below the limit: a request of another process that the file did not see still fits
const MAX_IN_WINDOW = Math.max(1, MagicLinkThrottle.limit - 1)

type Stamps = Record<string, number[]>

function isStamps(value: unknown): value is Stamps {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      list => Array.isArray(list) && list.every(at => typeof at === 'number')
    )
  )
}

function readStamps(): Stamps {
  try {
    const parsed: unknown = JSON.parse(readFileSync(STAMPS_FILE, 'utf8'))
    return isStamps(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

// Written to a file beside it and renamed, so a reader never sees half of it
function writeStamps(stamps: Stamps): void {
  const draft = `${STAMPS_FILE}.${process.pid}`
  writeFileSync(draft, JSON.stringify(stamps))
  renameSync(draft, STAMPS_FILE)
}

export function resetLinkBudget(): void {
  rmSync(STAMPS_FILE, { force: true })
}

export async function waitForLinkBudget(address: string): Promise<void> {
  // The api looks the user up with lower(email): one bucket for any spelling
  const email = address.toLowerCase()
  const startedAt = Date.now()
  for (;;) {
    const now = Date.now()
    const stamps = readStamps()
    const recent = (stamps[email] ?? []).filter(at => now - at < WINDOW_MS)
    if (recent.length < MAX_IN_WINDOW) {
      // The other addresses are pruned here too, so the file does not grow with every address seen
      const live = Object.fromEntries(
        Object.entries(stamps)
          .map(([key, list]) => [key, list.filter(at => now - at < WINDOW_MS)] as const)
          .filter(([, list]) => list.length > 0)
      )
      writeStamps({ ...live, [email]: [...recent, now] })
      return
    }
    if (now - startedAt > MAX_WAIT_MS) {
      throw new Error(`the magic-link budget of ${email} did not free up in ${MAX_WAIT_MS} ms`)
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}
