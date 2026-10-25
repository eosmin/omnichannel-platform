// Every model that carries a store_id must be in the tenant isolation suite (TDD_13 §6), or be
// exempt for a stated reason. The suite lists its resources as { name: 'conversation', ... }.
const MODEL_BLOCK = /^model (\w+) \{([\s\S]*?)^\}/gm
const STORE_ID_COLUMN = /@map\(\s*"store_id"\s*\)/
const LINE_COMMENT = /\/\/.*$/gm
const SUITE_RESOURCE = /\{\s*name:\s*'([A-Za-z0-9]+)'/g

export function storeScopedModels(schema: string): string[] {
  return [...schema.matchAll(MODEL_BLOCK)]
    .filter(([, , body]) => STORE_ID_COLUMN.test((body ?? '').replace(LINE_COMMENT, '')))
    .map(([, name]) => name ?? '')
    .sort()
}

export function suiteResources(suite: string): string[] {
  return [...suite.matchAll(SUITE_RESOURCE)].map(([, name]) => name ?? '').sort()
}

// The suite names a resource in camelCase (smsLog) and the schema in PascalCase (SMSLog): compared
// without the case, so that an acronym does not need an odd spelling
const sameName = (model: string, resource: string): boolean =>
  model.toLowerCase() === resource.toLowerCase()

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
  const uncovered = models.filter(
    model =>
      !resources.some(resource => sameName(model, resource)) && !Object.hasOwn(exemptions, model)
  )
  const stale = [
    ...Object.keys(exemptions).filter(model => !models.includes(model)),
    ...resources.filter(resource => !models.some(model => sameName(model, resource)))
  ]
  return { uncovered, stale: [...new Set(stale)].sort() }
}
