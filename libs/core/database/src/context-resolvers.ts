import type { PrismaService } from './prisma.service'
import type { TenantContext } from './tenant-context'

// The lookups that run BEFORE there is a tenant context (migration 20270121110000_rls_phase1): the site key of a widget, the key
// of a plugin installation, the key of a store and the id of a carrier connection in the address of its webhook. Each is a SQL
// function of the owner of the tables that answers one row for an exact key, with the ids that open the context and nothing
// else. What the caller needs besides (a status, a scope, a secret) it reads from the row afterwards, inside the context
// `contextOf` gives it. No store is ever passed in: the store is what the function finds.
export interface ResolvedRow {
  // The row that was asked for (the connection, the installation, the key)
  id: string
  storeId: string
  organizationId: string
}

interface ResolvedRecord {
  id: string
  store_id: string
  organization_id: string
}

function first(rows: readonly ResolvedRecord[]): ResolvedRow | null {
  const row = rows[0]
  return row === undefined
    ? null
    : { id: row.id, storeId: row.store_id, organizationId: row.organization_id }
}

// The context that opens the rows of the store a lookup found
export function contextOf(row: ResolvedRow): TenantContext {
  return { storeIds: [row.storeId], organizationIds: [row.organizationId] }
}

type Reader = Pick<PrismaService['client'], '$queryRaw'>

export async function resolveWidgetSite(
  db: Reader,
  pluginId: string,
  siteKey: string
): Promise<ResolvedRow | null> {
  return first(
    await db.$queryRaw<ResolvedRecord[]>`SELECT * FROM resolve_widget_site(${pluginId}, ${siteKey})`
  )
}

export async function resolvePluginInstallation(
  db: Reader,
  keyHash: string
): Promise<ResolvedRow | null> {
  return first(
    await db.$queryRaw<ResolvedRecord[]>`SELECT * FROM resolve_plugin_installation(${keyHash})`
  )
}

// The status of the plugin an installation points at, asked by the same key hash. The plugin row can be hidden by the policy of
// `plugins` from the context of the store (a plugin registered by another organization), so it is not read inside that context.
// null: no installation or no plugin row for that hash.
export async function resolvePluginInstallationPluginStatus(
  db: Reader,
  keyHash: string
): Promise<string | null> {
  const rows = await db.$queryRaw<
    { plugin_status: string }[]
  >`SELECT * FROM lookup_plugin_status_of_key(${keyHash})`
  return rows[0]?.plugin_status ?? null
}

export async function resolveApiKey(db: Reader, keyHash: string): Promise<ResolvedRow | null> {
  return first(await db.$queryRaw<ResolvedRecord[]>`SELECT * FROM resolve_api_key(${keyHash})`)
}

export async function resolveCarrierConnection(
  db: Reader,
  connectionId: string
): Promise<ResolvedRow | null> {
  return first(
    await db.$queryRaw<ResolvedRecord[]>`SELECT * FROM resolve_carrier_connection(${connectionId})`
  )
}
