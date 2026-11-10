// Every model that carries a store_id, or an organization_id (the resources of an ORGANIZATION: the warehouses,
// TDD_16 §1), must be in the tenant isolation suite (TDD_13 §6, TDD_16 §8), or be exempt for a stated reason. The suite lists its resources as { name: 'conversation', create, ... }.
const MODEL_BLOCK = /^model (\w+) \{([\s\S]*?)^\}/gm
const STORE_ID_COLUMN = /@map\(\s*"store_id"\s*\)/
const ORGANIZATION_ID_COLUMN = /@map\(\s*"organization_id"\s*\)/
// The tenants themselves: a store carries its organization_id because it BELONGS to it, and is what the guards
// resolve, not a resource they protect (the isolation of the stores is the whole of the suite)
const TENANT_ROOTS: readonly string[] = ['Store']
const LINE_COMMENT = /\/\/.*$/gm
// A resource is an object that starts with its name and then says how to create one: any other
// `{ name: '...' }` of the file (a body that renames something, for example) is not one
const SUITE_RESOURCE = /\{\s*name:\s*'([A-Za-z0-9]+)',\s*create:/g

export function storeScopedModels(schema: string): string[] {
  return [...schema.matchAll(MODEL_BLOCK)]
    .filter(([, , body]) => STORE_ID_COLUMN.test((body ?? '').replace(LINE_COMMENT, '')))
    .map(([, name]) => name ?? '')
    .sort()
}

// The models of an organization that name no store: they are visible to the members of any store of the
// organization, and a member of another organization must never reach them
export function organizationScopedModels(schema: string): string[] {
  return [...schema.matchAll(MODEL_BLOCK)]
    .filter(([, name, body]) => {
      const columns = (body ?? '').replace(LINE_COMMENT, '')
      return (
        !TENANT_ROOTS.includes(name ?? '') &&
        ORGANIZATION_ID_COLUMN.test(columns) &&
        !STORE_ID_COLUMN.test(columns)
      )
    })
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

// A model with no case of its own, why, and the step of the plan that builds its endpoint. The step
// is what stops an exemption from outliving the reason for it.
export interface IsolationExemption {
  reason: string
  step: string
}

export interface IsolationReport {
  uncovered: string[]
  // A model that is exempt and no longer carries a store_id or already has its case, or a resource of
  // the suite with no model
  stale: string[]
}

// exemptions: model -> why it needs no case of its own (for example, it is reached through its parent)
export function checkIsolationCoverage(
  models: readonly string[],
  resources: readonly string[],
  exemptions: Readonly<Record<string, unknown>>
): IsolationReport {
  const uncovered = models.filter(
    model =>
      !resources.some(resource => sameName(model, resource)) && !Object.hasOwn(exemptions, model)
  )
  const stale = [
    ...Object.keys(exemptions).filter(
      model => !models.includes(model) || resources.some(resource => sameName(model, resource))
    ),
    ...resources.filter(resource => !models.some(model => sameName(model, resource)))
  ]
  return { uncovered, stale: [...new Set(stale)].sort() }
}

// The progress table of the plan: | 1.2 | Tenancy | done | #39 | 2026-10-25 |  ->  { '1.2': 'done' }
const PROGRESS_ROW = /^\|\s*(\d+\.\d+)\s*\|[^|]*\|\s*([^|]*?)\s*\|/gm
// Other tables of the plan (the CI jobs by step) also start their rows with a step number
const PROGRESS_HEADING = '## Progress tracking'

export function planSteps(plan: string): Map<string, string> {
  const start = plan.indexOf(PROGRESS_HEADING)
  const progress = start === -1 ? '' : plan.slice(start)
  return new Map(
    [...progress.matchAll(PROGRESS_ROW)].map(([, step, status]) => [step ?? '', status ?? ''])
  )
}

export interface ExemptionReport {
  // Exempt for a step that does not exist in the plan, or with no reason
  invalid: string[]
  // Exempt until a step that is done: the resource exists now, and its case has to be in the suite
  due: string[]
}

export function checkExemptions(
  exemptions: Readonly<Record<string, IsolationExemption>>,
  steps: ReadonlyMap<string, string>
): ExemptionReport {
  const entries = Object.entries(exemptions)
  const invalid = entries
    .filter(([, { reason, step }]) => reason.trim() === '' || !steps.has(step))
    .map(([model]) => model)
  const due = entries.filter(([, { step }]) => steps.get(step) === 'done').map(([model]) => model)
  return { invalid: invalid.sort(), due: due.sort() }
}
