import type { ConnectFieldView } from './channels-requests'

// The connect form of a channel is drawn from what the plugin asks for (`connectFields`); these are
// the rules that turn what was typed into the `credentials` the api takes. The plugin still checks
// them: this only spares a request that cannot succeed.

// A plugin names the text of its fields by message key; only the keys the channels' own section holds
// are looked up, so a key aimed at another part of the interface cannot relabel a field
export const ChannelMessagePrefix = 'settings.channels.'

export type ConnectValues = Record<string, string>

// One entry per line, without blanks or repeats: the form of a field that holds a list
export function linesOf(text: string): string[] {
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const entry = line.trim()
    if (entry !== '') seen.add(entry)
  }
  return [...seen]
}

export function emptyValues(fields: readonly ConnectFieldView[]): ConnectValues {
  return Object.fromEntries(fields.map(field => [field.key, '']))
}

// The fields that are required and have nothing typed
export function missingFields(
  fields: readonly ConnectFieldView[],
  values: ConnectValues
): ConnectFieldView[] {
  return fields.filter(field => field.required && valueOf(field, values).length === 0)
}

function valueOf(field: ConnectFieldView, values: ConnectValues): string | string[] {
  const typed = values[field.key] ?? ''
  return field.multiple ? linesOf(typed) : typed.trim()
}

// Only the fields with something typed: an optional one left empty is not sent
export function credentialsOf(
  fields: readonly ConnectFieldView[],
  values: ConnectValues
): Record<string, string | string[]> {
  const credentials: Record<string, string | string[]> = {}
  for (const field of fields) {
    const value = valueOf(field, values)
    if (value.length > 0) credentials[field.key] = value
  }
  return credentials
}
