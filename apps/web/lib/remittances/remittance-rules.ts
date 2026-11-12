import type {
  PendingConnectionView,
  RemittanceDetailView,
  RemittanceLineView
} from '@platform/api-client'
import {
  RemittanceLimits,
  SettlingOutcomes,
  RemittanceLineOutcome,
  RemittanceStatus,
  type UpdateRemittanceLineBody
} from '@platform/core/domain'

import { parseCents } from '../products/money'

// The rules the remittance screens apply, as pure functions. Every amount is whole cents: nothing here goes through a float.

export type OutcomeTone = 'ok' | 'warning' | 'problem'

// How a screen shows the outcome of a line: the ones that settle are quiet, a difference warns, and a line that points at no
// shipment (or a repeated one) is a problem the agent must read before confirming
export function outcomeTone(outcome: RemittanceLineOutcome): OutcomeTone {
  switch (outcome) {
    case RemittanceLineOutcome.MATCHED:
      return 'ok'
    case RemittanceLineOutcome.AMOUNT_DIFFERS:
    case RemittanceLineOutcome.ALREADY_REMITTED:
      return 'warning'
    default:
      return 'problem'
  }
}

export function isSettling(line: Pick<RemittanceLineView, 'outcome' | 'excluded'>): boolean {
  return !line.excluded && SettlingOutcomes.includes(line.outcome)
}

export function outcomeCounts(
  lines: readonly Pick<RemittanceLineView, 'outcome' | 'excluded'>[]
): Record<RemittanceLineOutcome, number> {
  const counts = Object.fromEntries(
    Object.values(RemittanceLineOutcome).map(outcome => [outcome, 0])
  ) as Record<RemittanceLineOutcome, number>
  for (const line of lines) {
    if (!line.excluded) counts[line.outcome] += 1
  }
  return counts
}

export function isDraft(remittance: Pick<RemittanceDetailView, 'status'>): boolean {
  return remittance.status === RemittanceStatus.DRAFT
}

// A draft can be confirmed when at least one line that is not left out would settle a shipment (the api refuses the rest with
// REMITTANCE_NOTHING_TO_SETTLE; saying it before the press saves a round trip)
export function mayConfirm(remittance: RemittanceDetailView): boolean {
  return isDraft(remittance) && remittance.lines.some(isSettling)
}

// The lines that are not left out and that settle nothing: shown as a count before the confirmation, so a person reads them
export function unsettledCount(remittance: RemittanceDetailView): number {
  return remittance.lines.filter(line => !line.excluded && !SettlingOutcomes.includes(line.outcome))
    .length
}

// What a person typed for an amount, as cents: "15", "15.50", "15,5". Null for anything else, and for more than a line takes
export function parseAmountInput(text: string): number | null {
  const cents = parseCents(text)
  return cents !== null && cents <= RemittanceLimits.MAX_AMOUNT_CENTS ? cents : null
}

export interface LineEditInput {
  // The amount the carrier reported, as typed; empty is not an amount
  reported: string
  // The fee the carrier took, as typed; empty takes it back
  fee: string
  note: string
  excluded: boolean
}

export type LineEditResult =
  { ok: true; body: UpdateRemittanceLineBody | null } | { ok: false; field: 'reported' | 'fee' }

// The body that saves the edit of one line, with only the fields that changed (the api refuses an empty body, so `null`
// says nothing changed). An amount that is not one is refused here and named, never sent as zero.
export function lineEditBody(line: RemittanceLineView, input: LineEditInput): LineEditResult {
  const body: UpdateRemittanceLineBody = {}
  const reported = parseAmountInput(input.reported)
  if (reported === null) return { ok: false, field: 'reported' }
  if (reported !== line.reportedCents) body.reportedCents = reported
  const feeText = input.fee.trim()
  const fee = feeText === '' ? null : parseAmountInput(feeText)
  if (feeText !== '' && fee === null) return { ok: false, field: 'fee' }
  if (fee !== line.reportedFeeCents) body.reportedFeeCents = fee
  const note = input.note.trim() === '' ? null : input.note.trim()
  if (note !== line.note) body.note = note
  if (input.excluded !== line.excluded) body.excluded = input.excluded
  return { ok: true, body: Object.keys(body).length === 0 ? null : body }
}

export interface PendingSummary {
  // What the carriers owe across every connection, signed (a credit of one offsets the debt of another)
  totalOwedCents: number
  count: number
  // Days the oldest shipment has waited, or null when none has an age
  oldestAgeDays: number | null
}

export function pendingSummary(connections: readonly PendingConnectionView[]): PendingSummary {
  let oldest: number | null = null
  for (const connection of connections) {
    if (
      connection.oldestAgeDays !== null &&
      (oldest === null || connection.oldestAgeDays > oldest)
    ) {
      oldest = connection.oldestAgeDays
    }
  }
  return {
    totalOwedCents: connections.reduce((sum, connection) => sum + connection.totalOwedCents, 0),
    count: connections.reduce((sum, connection) => sum + connection.count, 0),
    oldestAgeDays: oldest
  }
}

// The warning of delay: a connection whose oldest shipment waited longer than the threshold of the store. No threshold read
// (the person cannot see the preferences) is no warning, never a guess.
export function isOverdue(ageDays: number | null, thresholdDays: number | null): boolean {
  return ageDays !== null && thresholdDays !== null && ageDays > thresholdDays
}
