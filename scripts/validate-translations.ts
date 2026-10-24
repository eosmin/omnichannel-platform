// Fails when a supported locale lacks a key of the source locale, or the source lacks a key that
// the constants imply (enum values, error codes, notification types).
// Usage: tsx scripts/validate-translations.ts
import { existsSync, readFileSync } from 'node:fs'
import { exit } from 'node:process'

import { generatedI18nKeys, SOURCE_LOCALE, SUPPORTED_LOCALES } from '@platform/core/i18n'

import { findMissingTranslations, flattenKeys, type LocaleKeys } from './lib/translations'

const MESSAGES_DIR = 'apps/web/messages'

function load(locale: string): LocaleKeys {
  const file = `${MESSAGES_DIR}/${locale}.json`
  if (!existsSync(file)) {
    console.error(`${file} is missing: every supported locale needs its message file`)
    exit(1)
  }
  const messages = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  return { locale, keys: new Set(flattenKeys(messages)) }
}

// The message files arrive with the web app (Step 3.1): until then there is nothing to compare
if (!existsSync(MESSAGES_DIR)) {
  console.log(`${MESSAGES_DIR} does not exist yet: no translations to validate`)
  exit(0)
}

const problems = findMissingTranslations(
  load(SOURCE_LOCALE),
  SUPPORTED_LOCALES.filter(locale => locale !== SOURCE_LOCALE).map(load),
  generatedI18nKeys()
)

if (problems.length > 0) {
  for (const { locale, missing } of problems) {
    console.error(`[${locale}] missing ${missing.length} keys:\n  ${missing.join('\n  ')}`)
  }
  exit(1)
}
console.log(`translations complete for ${SUPPORTED_LOCALES.join(', ')}`)
