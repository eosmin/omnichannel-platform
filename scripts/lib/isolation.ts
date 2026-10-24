// Every model that carries a store_id must be in the tenant isolation suite (TDD_13 §6), or be
// exempt for a stated reason. The suite lists its resources as { name: 'conversation', ... }.
const MODEL_BLOCK = /^model (\w+) \{([\s\S]*?)^\}/gm
const STORE_ID_COLUMN = /@map\("store_id"\)/
const SUITE_RESOURCE = /\{\s*name:\s*'([A-Za-z0-9]+)'/g

export function storeScopedModels(schema: string): string[] {
  return [...schema.matchAll(MODEL_BLOCK)]
    .filter(([, , body]) => STORE_ID_COLUMN.test(body ?? ''))
    .map(([, name]) => name ?? '')
    .sort()
}

export function suiteResources(suite: string): string[] {
  return [...suite.matchAll(SUITE_RESOURCE)].map(([, name]) => name ?? '').sort()
}

const lowerFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1)

export interface IsolationReport {
  uncovered: string[]
  // A model that is exempt and no longer carries a store_id, or a resource of the suite with no model
  stale: string[]
}

// exemptions: model -> why it needs no case of its own (for example, it is reached through its parent)
export function checkIsolationCoverage(
  models: readonly string[],
  resources: readonly string[],
  exemptions: Readonly<Record<string, string>>
): IsolationReport {
  const covered = new Set(resources)
  const uncovered = models.filter(
    model => !covered.has(lowerFirst(model)) && exemptions[model] === undefined
  )
  const stale = [
    ...Object.keys(exemptions).filter(model => !models.includes(model)),
    ...resources.filter(resource => !models.some(model => lowerFirst(model) === resource))
  ]
  return { uncovered, stale: [...new Set(stale)].sort() }
}
