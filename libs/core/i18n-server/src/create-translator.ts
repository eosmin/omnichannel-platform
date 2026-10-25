import type { Locale } from '@platform/core/i18n'

import { messagesFor } from './messages'

export type TranslationParams = Record<string, string | number>
export type Translator = (key: string, params?: TranslationParams) => string

function lookup(node: unknown, path: readonly string[]): string | undefined {
  let current = node
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment] // Indexing a JSON object by a key we just split
  }
  return typeof current === 'string' ? current : undefined
}

// createTranslator('es', 'email.magicLink')('subject'). A missing key or parameter throws instead of
// sending an email with a hole in it: the golden render tests of every template catch it first.
export function createTranslator(locale: Locale, namespace: string): Translator {
  const messages = messagesFor(locale)
  return (key, params = {}) => {
    const path = `${namespace}.${key}`
    const template = lookup(messages, path.split('.'))
    if (template === undefined) throw new Error(`missing translation ${path} for ${locale}`)
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = params[name]
      if (value === undefined) throw new Error(`missing parameter ${name} for ${path}`)
      return String(value)
    })
  }
}
