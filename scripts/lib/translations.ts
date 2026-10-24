// Message files are nested JSON ("orders": { "status": { "OPEN": "..." } }); the keys the code asks
// for are the dotted paths of the leaves ("orders.status.OPEN").
export function flattenKeys(messages: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(messages).flatMap(([name, value]) => {
    const key = prefix === '' ? name : `${prefix}.${name}`
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? flattenKeys(value as Record<string, unknown>, key)
      : [key]
  })
}

export interface TranslationProblem {
  locale: string
  missing: string[]
}

export interface LocaleKeys {
  locale: string
  keys: ReadonlySet<string>
}

// The source locale must hold every key the constants imply, and every other locale every key of
// the source (TDD_09 §15.6).
export function findMissingTranslations(
  source: LocaleKeys,
  others: readonly LocaleKeys[],
  generatedKeys: readonly string[]
): TranslationProblem[] {
  const problems: TranslationProblem[] = []
  const missingGenerated = generatedKeys.filter(key => !source.keys.has(key))
  if (missingGenerated.length > 0)
    problems.push({ locale: source.locale, missing: missingGenerated })
  for (const other of others) {
    const missing = [...source.keys].filter(key => !other.keys.has(key)).sort()
    if (missing.length > 0) problems.push({ locale: other.locale, missing })
  }
  return problems
}
