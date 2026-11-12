// Fails when a supported locale lacks a key of the source locale, or the source lacks a key that
// the constants imply (enum values, error codes, notification types).
// Usage: tsx scripts/validate-translations.ts
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { exit } from 'node:process'

import { generatedI18nKeys, SOURCE_LOCALE, SUPPORTED_LOCALES } from '@platform/core/i18n'

import { findMissingTranslations, flattenKeys, type LocaleKeys } from './lib/translations'

const MESSAGES_DIR = 'apps/web/messages'
// The messages of one route, which only that route loads (`<name>.<locale>.json`): their keys are full paths, so they count as
// keys of the locale like the rest
const ROUTES_DIR = `${MESSAGES_DIR}/routes`

function readObject(file: string): Record<string, unknown> {
  let messages: unknown
  try {
    messages = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    console.error(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
    exit(1)
  }
  if (typeof messages !== 'object' || messages === null || Array.isArray(messages)) {
    console.error(`${file} must hold an object of messages`)
    exit(1)
  }
  return messages as Record<string, unknown>
}

function load(locale: string): LocaleKeys {
  const file = `${MESSAGES_DIR}/${locale}.json`
  if (!existsSync(file)) {
    console.error(`${file} is missing: every supported locale needs its message file`)
    exit(1)
  }
  const keys = new Set(flattenKeys(readObject(file)))
  const routeFiles = existsSync(ROUTES_DIR)
    ? readdirSync(ROUTES_DIR).filter(name => name.endsWith(`.${locale}.json`))
    : []
  for (const name of routeFiles) {
    for (const key of flattenKeys(readObject(`${ROUTES_DIR}/${name}`))) keys.add(key)
  }
  return { locale, keys }
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
