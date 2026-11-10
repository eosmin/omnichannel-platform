import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from '@playwright/test'

import { MagicLinkThrottle } from '@platform/core/auth'

import { magicLinkLimitInForce } from './env'

// The api allows `magicLinkLimitInForce` links a minute per address (the real `MagicLinkThrottle.limit`, or the
// one the suite asked of the api it starts, see env.ts), whatever the IP, and the specs
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
export function maxInWindow(): number {
  return Math.max(1, magicLinkLimitInForce() - 1)
}

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

// How long until the address has room: the oldest stamps that fill the window leave it after that
function msUntilRoom(recent: number[], now: number): number {
  const blocking = recent[recent.length - maxInWindow()]
  return blocking === undefined ? 0 : Math.max(0, blocking + WINDOW_MS - now)
}

// The wait for room is not the test: a case that must wait for the window of its address to free up has
// its own time to do what it came to do. The wait is measured (the stamps say when room comes), and the
// timeout of the case grows by exactly that, once for each wait, never more: the time the case has for
// its own steps, and the timeout of every assertion, stay as they were. Outside a case (the global setup)
// there is no timeout to grow, and a case with no timeout (0, a debug run) keeps having none.
function giveTheWaitItsOwnTime(email: string, ms: number): void {
  let info: ReturnType<typeof test.info> | undefined
  try {
    info = test.info()
  } catch {
    info = undefined
  }
  // The line goes to the log of the run, where a slow suite can be told from a stuck one
  process.stdout.write(`[link-budget] ${email} waits ${ms} ms for room in the window of the api\n`)
  if (info !== undefined && info.timeout !== 0) info.setTimeout(info.timeout + ms)
}

// For the spec that proves the wait: fills the window of an address with the moments given
export function seedLinkBudget(address: string, stamps: number[]): void {
  writeStamps({ ...readStamps(), [address.toLowerCase()]: stamps })
}

export async function waitForLinkBudget(address: string): Promise<void> {
  // The api looks the user up with lower(email): one bucket for any spelling
  const email = address.toLowerCase()
  const startedAt = Date.now()
  let hasWaited = false
  for (;;) {
    const now = Date.now()
    const stamps = readStamps()
    const recent = (stamps[email] ?? []).filter(at => now - at < WINDOW_MS)
    if (recent.length < maxInWindow()) {
      // The other addresses are pruned here too, so the file does not grow with every address seen
      const live = Object.fromEntries(
        Object.entries(stamps)
          .map(([key, list]) => [key, list.filter(at => now - at < WINDOW_MS)] as const)
          .filter(([, list]) => list.length > 0)
      )
      writeStamps({ ...live, [email]: [...recent, now] })
      return
    }
    if (!hasWaited) {
      hasWaited = true
      giveTheWaitItsOwnTime(email, msUntilRoom(recent, now) + POLL_MS)
    }
    if (now - startedAt > MAX_WAIT_MS) {
      throw new Error(`the magic-link budget of ${email} did not free up in ${MAX_WAIT_MS} ms`)
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}
