import { pluginManifestSchema } from './plugin-manifest'

export interface StoredManifestRow {
  id: string
  manifest: unknown
}

export interface ManifestProblem {
  pluginId: string
  // One line per thing the manifest of today refuses: the path inside the manifest and why
  issues: string[]
}

// The manifests a registry holds were checked by the parser of their day. This runs the parser of today over them, so a manifest that
// would now be refused (a third language in `names` or in the label of a field, a widget limit out of range: PLG-008 a) is found
// before the registry opens to third parties, and not when its plugin is installed or its channel is synced. It reads nothing but
// the rows it is given and changes none.
export function findInvalidManifests(rows: readonly StoredManifestRow[]): ManifestProblem[] {
  const problems: ManifestProblem[] = []
  for (const row of rows) {
    const parsed = pluginManifestSchema.safeParse(row.manifest)
    if (parsed.success) continue
    problems.push({
      pluginId: row.id,
      issues: parsed.error.issues.map(
        issue =>
          `${issue.path.length === 0 ? '(manifest)' : issue.path.join('.')}: ${issue.message}`
      )
    })
  }
  return problems
}
