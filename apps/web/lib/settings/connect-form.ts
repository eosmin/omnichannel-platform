import type { ConnectFieldView } from './channels-requests'

// The connect form of a channel is drawn from what the plugin asks for (`connectFields`); these are
// the rules that turn what was typed into the `credentials` the api takes. The plugin still checks
// them: this only spares a request that cannot succeed.

// A plugin names the text of its fields by message key; only the keys the channels' own section holds
// are looked up, so a key aimed at another part of the interface cannot relabel a field
export const ChannelMessagePrefix = 'settings.channels.'

// The text a field is drawn with: the message of the page where the field names one this page has (an official
// plugin), else the text the plugin wrote in the language of the reader (English for any other), else the key.
// `message` answers null for a key the page does not hold.
export function fieldLabelOf(
  field: Pick<ConnectFieldView, 'key' | 'labelKey' | 'label'>,
  locale: string,
  message: (key: string) => string | null,
  prefix: string = ChannelMessagePrefix
): string {
  if (field.labelKey?.startsWith(prefix) === true) {
    const text = message(field.labelKey)
    if (text !== null) return text
  }
  if (field.label !== null) {
    return locale.toLowerCase().startsWith('es') ? field.label.es : field.label.en
  }
  return field.key
}

// The line of help of a field: only a key of the page's own section is looked up, and a plugin that names none draws none
export function fieldHelpOf(
  field: Pick<ConnectFieldView, 'helpKey'>,
  message: (key: string) => string | null,
  prefix: string = ChannelMessagePrefix
): string | null {
  return field.helpKey?.startsWith(prefix) === true ? message(field.helpKey) : null
}

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
