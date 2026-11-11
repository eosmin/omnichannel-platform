import {
  MessageLimits,
  type OrderMessageVariable,
  OrderMessageNotSentReasons,
  OrderMessageVariables
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

// {{name}}: the only syntax of a template. Anything else between braces is text, and a name that is not in the allowlist is
// refused when the template is saved (TDD_17 §4.7). Rendering is substitution, never the evaluation of anything.
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g

const ALLOWED: ReadonlySet<string> = new Set(Object.values(OrderMessageVariables))

export function isOrderMessageVariable(name: string): name is OrderMessageVariable {
  return ALLOWED.has(name)
}

// The names a body uses, in order of first appearance and without repeats; unknown ones included
export function variablesUsedBy(body: string): string[] {
  const names = new Set<string>()
  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1]
    if (name !== undefined) names.add(name)
  }
  return [...names]
}

// The variables the body names that are not in the allowlist
export function unknownVariablesOf(body: string): string[] {
  return variablesUsedBy(body).filter(name => !isOrderMessageVariable(name))
}

// A template with a variable that does not exist is refused whole: it could never be filled in
export function assertKnownVariables(body: string): void {
  const unknown = unknownVariablesOf(body)
  if (unknown.length > 0) {
    throw new PlatformException(
      ErrorCodes.ORDER_MESSAGE_VARIABLE_UNKNOWN,
      'the template uses a variable that does not exist',
      HttpStatusCodes.BAD_REQUEST,
      { variables: unknown }
    )
  }
}

// Every variable a template needs a value for: the ones of its text and the ones that fill its channel-approved template
// (which is what the customer reads when the window is closed, so it needs the same values)
export function variablesNeededBy(
  body: string,
  channelVariables: readonly OrderMessageVariable[] = []
): OrderMessageVariable[] {
  const needed = new Set<OrderMessageVariable>(channelVariables)
  for (const name of variablesUsedBy(body)) {
    if (isOrderMessageVariable(name)) needed.add(name)
  }
  return [...needed]
}

export type OrderMessageValues = Partial<Record<OrderMessageVariable, string>>

export type RenderResult =
  | { ok: true; text: string }
  // The variables the template uses that the order has no value for, or that do not exist (a body saved before a variable
  // was removed): the message is not sent (reason MISSING_VARIABLE), so it never reaches the customer with a hole in it
  | { ok: false; reason: typeof OrderMessageNotSentReasons.MISSING_VARIABLE; missing: string[] }
  // The text, filled in, is longer than a channel takes: refused with a reason instead of cut or dropped late
  | { ok: false; reason: typeof OrderMessageNotSentReasons.TOO_LONG; length: number }

// Every variable a template needs that has no value: the unknown names of its text first, then the allowlisted ones of its
// text and of the variables that fill its channel-approved template (the one the customer reads when the window is closed,
// which needs the same values). A caller that sends through either path asks this, so one check covers both.
export function missingVariablesOf(
  body: string,
  channelVariables: readonly OrderMessageVariable[],
  values: OrderMessageValues
): string[] {
  const absent = variablesNeededBy(body, channelVariables).filter(name => {
    const value = values[name]
    return value === undefined || value.trim() === ''
  })
  return [...unknownVariablesOf(body), ...absent]
}

// Fills a body from the values of an order. One pass: a value that itself contains `{{name}}` stays as written, so what a
// customer typed in their name can never reach another variable. A used variable with no value (or an empty one) is
// reported and nothing is rendered. `channelVariables` are the ones of the approved template linked to it, which count too.
export function renderOrderMessage(
  body: string,
  values: OrderMessageValues,
  channelVariables: readonly OrderMessageVariable[] = []
): RenderResult {
  const missing = missingVariablesOf(body, channelVariables, values)
  if (missing.length > 0) {
    return { ok: false, reason: OrderMessageNotSentReasons.MISSING_VARIABLE, missing }
  }
  const text = body.replace(PLACEHOLDER, (whole, name: string) =>
    isOrderMessageVariable(name) ? (values[name] ?? whole) : whole
  )
  const length = Array.from(text).length
  if (length > MessageLimits.CONTENT_MAX_LENGTH) {
    return { ok: false, reason: OrderMessageNotSentReasons.TOO_LONG, length }
  }
  return { ok: true, text }
}

// The values of the variables a channel-approved template is filled with, in the order the owner mapped them. Missing ones
// are reported as in renderOrderMessage.
export function channelTemplateValues(
  variables: readonly OrderMessageVariable[],
  values: OrderMessageValues
): { ok: true; values: string[] } | { ok: false; missing: OrderMessageVariable[] } {
  const missing = variables.filter(name => (values[name] ?? '').trim() === '')
  if (missing.length > 0) return { ok: false, missing: [...new Set(missing)] }
  return { ok: true, values: variables.map(name => values[name] ?? '') }
}
