import type {
  CarrierConnectionView,
  ConnectCarrierInput,
  UpdateCarrierInput
} from '@platform/api-client'
import {
  CarrierCapability,
  CarrierConnectionLimits,
  CLOCK_TIME_PATTERN,
  LocalGuide,
  shippingFeeRangeProblem
} from '@platform/core/domain'

import { centsToInput, parseCents } from '../products/money'

// The forms of Settings → Carriers as plain values, and the checks done before the request. The api checks the same and
// decides. Nothing here knows a carrier: what a form asks for comes from the capabilities the connection or the registry
// declares.

// The days of a pickup as the api counts them: 1 is Monday and 7 is Sunday
export const PICKUP_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const

export const CarrierRulesProblems = {
  NAME: 'name',
  NO_DAYS: 'noDays',
  CUTOFF: 'cutoff',
  AUTO_NEEDS_PICKUPS: 'autoNeedsPickups',
  AUTO_TIME: 'autoTime',
  REMINDER: 'reminder',
  CREDENTIALS: 'credentials',
  SERVICE_LABEL: 'serviceLabel',
  DEFAULT_SERVICE: 'defaultService',
  FEE: 'fee',
  FEE_RANGE: 'feeRange',
  ATTEMPTS: 'attempts',
  POLL: 'poll'
} as const
export type CarrierRulesProblem = (typeof CarrierRulesProblems)[keyof typeof CarrierRulesProblems]

export interface CarrierRulesDraft {
  displayName: string
  isDefault: boolean
  pickupEnabled: boolean
  pickupDays: number[]
  // HH:MM as typed; empty is "no cutoff"
  pickupCutoffTime: string
  autoPickup: boolean
  autoPickupTime: string
  // Digits as typed
  pickupReminderMinutes: string
  // New credentials, as a JSON object; empty keeps the ones the connection has
  credentials: string
  defaultServiceCode: string
  defaultShippingPayer: string
  labelFormat: string
  // Money as typed ("15.50"); empty is "none"
  defaultFee: string
  minFee: string
  maxFee: string
  remittanceDeductsFee: boolean
  // Digits as typed
  maxDeliveryAttempts: string
  // Digits as typed; empty is "the platform's own interval"
  pollIntervalMinutes: string
  services: { code: string; label: string; active: boolean }[]
}

export function carrierRulesDraftOf(view: CarrierConnectionView): CarrierRulesDraft {
  return {
    displayName: view.displayName,
    isDefault: view.isDefault,
    pickupEnabled: view.pickupEnabled,
    pickupDays: [...view.pickupDays].sort((a, b) => a - b),
    pickupCutoffTime: view.pickupCutoffTime ?? '',
    autoPickup: view.autoPickup,
    autoPickupTime: view.autoPickupTime ?? '',
    pickupReminderMinutes: String(view.pickupReminderMinutes),
    credentials: '',
    defaultServiceCode: view.defaultServiceCode ?? '',
    defaultShippingPayer: view.defaultShippingPayer,
    labelFormat: view.labelFormat,
    defaultFee: feeInput(view.defaultShippingFeeCents),
    minFee: feeInput(view.minShippingFeeCents),
    maxFee: feeInput(view.maxShippingFeeCents),
    remittanceDeductsFee: view.remittanceDeductsFee,
    maxDeliveryAttempts: String(view.maxDeliveryAttempts),
    pollIntervalMinutes: view.pollIntervalMinutes === null ? '' : String(view.pollIntervalMinutes),
    services: view.services.map(service => ({ ...service }))
  }
}

const feeInput = (cents: number | null): string => (cents === null ? '' : centsToInput(cents))

// Empty is none (null); otherwise an amount in dollars. Undefined is a text that is not one, or is over the limit.
function feeOf(text: string): number | null | undefined {
  if (text.trim() === '') return null
  const cents = parseCents(text)
  return cents !== null && cents <= CarrierConnectionLimits.MAX_FEE_CENTS ? cents : undefined
}

// Whole numbers inside a range; undefined for a text that is not one
function wholeOf(text: string, min: number, max: number): number | undefined {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return value >= min && value <= max ? value : undefined
}

// Empty is none (null); a time is HH:MM. Undefined is a text that is neither.
function clockOf(text: string): string | null | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return null
  return CLOCK_TIME_PATTERN.test(trimmed) ? trimmed : undefined
}

function reminderOf(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return value <= CarrierConnectionLimits.MAX_REMINDER_MINUTES ? value : undefined
}

// A JSON object that is not an array. `undefined` for a text that is not one; null for an empty text (nothing to send).
export function parseCredentials(text: string): Record<string, unknown> | null | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    const value: unknown = JSON.parse(trimmed)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

export function carrierRulesProblems(draft: CarrierRulesDraft): CarrierRulesProblem[] {
  const problems: CarrierRulesProblem[] = []
  const name = draft.displayName.trim()
  if (name === '' || name.length > CarrierConnectionLimits.DISPLAY_NAME_MAX_LENGTH) {
    problems.push(CarrierRulesProblems.NAME)
  }
  if (draft.pickupEnabled && draft.pickupDays.length === 0) {
    problems.push(CarrierRulesProblems.NO_DAYS)
  }
  if (clockOf(draft.pickupCutoffTime) === undefined) problems.push(CarrierRulesProblems.CUTOFF)
  if (draft.autoPickup && !draft.pickupEnabled) {
    problems.push(CarrierRulesProblems.AUTO_NEEDS_PICKUPS)
  }
  const auto = clockOf(draft.autoPickupTime)
  if (auto === undefined || (draft.autoPickup && auto === null)) {
    problems.push(CarrierRulesProblems.AUTO_TIME)
  }
  if (reminderOf(draft.pickupReminderMinutes) === undefined) {
    problems.push(CarrierRulesProblems.REMINDER)
  }
  if (parseCredentials(draft.credentials) === undefined) {
    problems.push(CarrierRulesProblems.CREDENTIALS)
  }
  if (
    draft.services.some(
      service =>
        service.label.trim() === '' ||
        service.label.trim().length > CarrierConnectionLimits.SERVICE_LABEL_MAX_LENGTH
    )
  ) {
    problems.push(CarrierRulesProblems.SERVICE_LABEL)
  }
  // The default service is one that stays active: switching it off needs another default first
  if (
    draft.defaultServiceCode !== '' &&
    draft.services.some(service => service.code === draft.defaultServiceCode && !service.active)
  ) {
    problems.push(CarrierRulesProblems.DEFAULT_SERVICE)
  }
  const fees = [feeOf(draft.defaultFee), feeOf(draft.minFee), feeOf(draft.maxFee)]
  if (fees.includes(undefined)) {
    problems.push(CarrierRulesProblems.FEE)
  } else if (
    shippingFeeRangeProblem({
      defaultShippingFeeCents: fees[0],
      minShippingFeeCents: fees[1],
      maxShippingFeeCents: fees[2]
    }) !== null
  ) {
    problems.push(CarrierRulesProblems.FEE_RANGE)
  }
  if (
    wholeOf(draft.maxDeliveryAttempts, 1, CarrierConnectionLimits.MAX_DELIVERY_ATTEMPTS) ===
    undefined
  ) {
    problems.push(CarrierRulesProblems.ATTEMPTS)
  }
  if (
    draft.pollIntervalMinutes.trim() !== '' &&
    wholeOf(draft.pollIntervalMinutes, 1, CarrierConnectionLimits.MAX_POLL_MINUTES) === undefined
  ) {
    problems.push(CarrierRulesProblems.POLL)
  }
  return problems
}

const sameDays = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((day, index) => day === b[index])

// Only what the person changed: a field they never touched must not overwrite what another person saved. Call it with
// no problems; a field that cannot be read is left out.
export function carrierRulesChanges(
  saved: CarrierConnectionView,
  draft: CarrierRulesDraft
): UpdateCarrierInput {
  const changes: UpdateCarrierInput = {}
  const name = draft.displayName.trim()
  if (name !== saved.displayName) changes.displayName = name
  // The default flag is only ever turned on here: another connection takes it over when that one is marked
  if (draft.isDefault && !saved.isDefault) changes.isDefault = true
  if (draft.pickupEnabled !== saved.pickupEnabled) changes.pickupEnabled = draft.pickupEnabled
  const days = [...draft.pickupDays].sort((a, b) => a - b)
  if (
    !sameDays(
      days,
      [...saved.pickupDays].sort((a, b) => a - b)
    )
  )
    changes.pickupDays = days
  const cutoff = clockOf(draft.pickupCutoffTime)
  if (cutoff !== undefined && cutoff !== saved.pickupCutoffTime) changes.pickupCutoffTime = cutoff
  if (draft.autoPickup !== saved.autoPickup) changes.autoPickup = draft.autoPickup
  const auto = clockOf(draft.autoPickupTime)
  if (auto !== undefined && auto !== saved.autoPickupTime) changes.autoPickupTime = auto
  const reminder = reminderOf(draft.pickupReminderMinutes)
  if (reminder !== undefined && reminder !== saved.pickupReminderMinutes) {
    changes.pickupReminderMinutes = reminder
  }
  const credentials = parseCredentials(draft.credentials)
  if (credentials !== null && credentials !== undefined) changes.credentials = credentials
  if (draft.defaultServiceCode !== '' && draft.defaultServiceCode !== saved.defaultServiceCode) {
    changes.defaultServiceCode = draft.defaultServiceCode
  }
  if (draft.defaultShippingPayer !== saved.defaultShippingPayer) {
    changes.defaultShippingPayer = draft.defaultShippingPayer
  }
  if (draft.labelFormat !== saved.labelFormat) changes.labelFormat = draft.labelFormat
  const defaultFee = feeOf(draft.defaultFee)
  if (defaultFee !== undefined && defaultFee !== saved.defaultShippingFeeCents) {
    changes.defaultShippingFeeCents = defaultFee
  }
  const minFee = feeOf(draft.minFee)
  if (minFee !== undefined && minFee !== saved.minShippingFeeCents) {
    changes.minShippingFeeCents = minFee
  }
  const maxFee = feeOf(draft.maxFee)
  if (maxFee !== undefined && maxFee !== saved.maxShippingFeeCents) {
    changes.maxShippingFeeCents = maxFee
  }
  if (draft.remittanceDeductsFee !== saved.remittanceDeductsFee) {
    changes.remittanceDeductsFee = draft.remittanceDeductsFee
  }
  const attempts = wholeOf(
    draft.maxDeliveryAttempts,
    1,
    CarrierConnectionLimits.MAX_DELIVERY_ATTEMPTS
  )
  if (attempts !== undefined && attempts !== saved.maxDeliveryAttempts) {
    changes.maxDeliveryAttempts = attempts
  }
  const poll =
    draft.pollIntervalMinutes.trim() === ''
      ? null
      : wholeOf(draft.pollIntervalMinutes, 1, CarrierConnectionLimits.MAX_POLL_MINUTES)
  if (poll !== undefined && poll !== saved.pollIntervalMinutes) {
    changes.pollIntervalMinutes = poll
  }
  const services = draft.services.flatMap(service => {
    const before = saved.services.find(item => item.code === service.code)
    if (before === undefined) return []
    const edit: { code: string; label?: string; active?: boolean } = { code: service.code }
    if (service.label.trim() !== before.label) edit.label = service.label.trim()
    if (service.active !== before.active) edit.active = service.active
    return Object.keys(edit).length > 1 ? [edit] : []
  })
  if (services.length > 0) changes.services = services
  return changes
}

// Whether the connection asks for the account's credentials, or is a courier the platform makes the guide for
export function hasInternalGuide(capabilities: readonly string[]): boolean {
  return capabilities.includes(CarrierCapability.INTERNAL_GUIDE)
}

// The pickup rules, the status mapping and the secret of the webhook are offered only where the connection can use them
export function canPoll(capabilities: readonly string[]): boolean {
  return capabilities.includes(CarrierCapability.FETCH_STATUS)
}

export function acceptsCashOnDelivery(capabilities: readonly string[]): boolean {
  return capabilities.includes(CarrierCapability.COD)
}

export function canReceiveWebhook(capabilities: readonly string[]): boolean {
  return capabilities.includes(CarrierCapability.WEBHOOK_STATUS)
}

// ---- Connecting ----

export const ConnectProblems = {
  CARRIER: 'carrier',
  NAME: 'name',
  CREDENTIALS: 'credentials',
  COURIER_NAME: 'courierName',
  COURIER_PHONE: 'courierPhone',
  COURIER_PREFIX: 'courierPrefix',
  COURIER_NOTES: 'courierNotes'
} as const
export type ConnectProblem = (typeof ConnectProblems)[keyof typeof ConnectProblems]

export interface ConnectDraft {
  carrierId: string
  displayName: string
  // A carrier with an account: its credentials as a JSON object, until the plugin declares the fields (Step 4.15)
  credentials: string
  // A courier the platform makes the guides for: what its guides and its label carry
  courierName: string
  courierPhone: string
  courierNotes: string
  courierPrefix: string
  isDefault: boolean
}

export const EMPTY_CONNECT_DRAFT: ConnectDraft = {
  carrierId: '',
  displayName: '',
  credentials: '',
  courierName: '',
  courierPhone: '',
  courierNotes: '',
  courierPrefix: '',
  isDefault: false
}

export interface ConnectTarget {
  capabilities: readonly string[]
  hasCredentials: boolean
}

export function connectProblems(
  draft: ConnectDraft,
  target: ConnectTarget | undefined
): ConnectProblem[] {
  if (target === undefined) return [ConnectProblems.CARRIER]
  const problems: ConnectProblem[] = []
  if (draft.displayName.trim().length > CarrierConnectionLimits.DISPLAY_NAME_MAX_LENGTH) {
    problems.push(ConnectProblems.NAME)
  }
  if (hasInternalGuide(target.capabilities)) {
    const courier = draft.courierName.trim()
    if (courier === '' || courier.length > CarrierConnectionLimits.DISPLAY_NAME_MAX_LENGTH) {
      problems.push(ConnectProblems.COURIER_NAME)
    }
    const phone = draft.courierPhone.trim()
    if (phone === '' || phone.length > CarrierConnectionLimits.CONTACT_PHONE_MAX_LENGTH) {
      problems.push(ConnectProblems.COURIER_PHONE)
    }
    const prefix = draft.courierPrefix.trim()
    if (!LocalGuide.PREFIX_PATTERN.test(prefix)) problems.push(ConnectProblems.COURIER_PREFIX)
    if (draft.courierNotes.trim().length > CarrierConnectionLimits.CONTACT_NOTES_MAX_LENGTH) {
      problems.push(ConnectProblems.COURIER_NOTES)
    }
  } else if (target.hasCredentials) {
    const credentials = parseCredentials(draft.credentials)
    if (credentials === undefined || credentials === null) {
      problems.push(ConnectProblems.CREDENTIALS)
    }
  }
  return problems
}

// The body of the connect call. Call it with no problems.
export function connectBody(draft: ConnectDraft, target: ConnectTarget): ConnectCarrierInput {
  const name = draft.displayName.trim()
  const base = {
    carrierId: draft.carrierId,
    ...(name === '' ? {} : { displayName: name }),
    ...(draft.isDefault ? { isDefault: true } : {})
  }
  if (hasInternalGuide(target.capabilities)) {
    const notes = draft.courierNotes.trim()
    return {
      ...base,
      credentials: {
        name: draft.courierName.trim(),
        phone: draft.courierPhone.trim(),
        ...(notes === '' ? {} : { notes }),
        prefix: draft.courierPrefix.trim()
      }
    }
  }
  return { ...base, credentials: parseCredentials(draft.credentials) ?? {} }
}
