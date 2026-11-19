import { Injectable } from '@nestjs/common'

import { PrismaService } from './prisma.service'
import { readAllPages } from './read-all-pages'

// The lists that a scheduler of the worker walks before it can name a store (RLS phase 5). Each one is a SECURITY DEFINER function of
// the database that returns ids and nothing else (migration 20270121800000_rls_worker_lists); the worker role has no policy-free
// access to those tables once it loses BYPASSRLS. A list is read PAGE by PAGE until a page comes back short, and a page that fails
// fails the whole walk: a list that stopped half way would be processed as if it were complete.

export interface ScheduledReportRef {
  id: string
  storeId: string
}
export interface ConnectionTarget {
  connectionId: string
  storeId: string
}
export interface PickupTarget {
  id: string
  storeId: string
}
export interface PickupSweepFilter {
  dateFrom: Date
  limit: number
}
export interface PendingPickupFilter extends PickupSweepFilter {
  status: string
  createdBefore: Date
}
export interface BehindPickupFilter extends PickupSweepFilter {
  statuses: readonly string[]
  updatedBefore: Date
}
export interface ChannelConnectionRef {
  id: string
  storeId: string
  pluginId: string
  updatedAt: Date
}

export interface ShipmentPollFilter {
  kind: string
  statuses: readonly string[]
  connectionStatus: string
}
export interface ChannelConnectionFilter {
  statuses: readonly string[]
  installationStatus: string
  pluginStatus: string
}

export interface RemoteChannelPluginFilter {
  type: string
  status: string
  installationStatus: string
}
// A private channel plugin with the stores that have it installed and active (what RemoteChannelSync registers)
export interface RemoteChannelPluginRef {
  id: string
  manifest: unknown
  storeIds: string[]
}

export interface AvatarMediaRef {
  id: string
  key: string
  status: string
  createdAt: Date
  uploadedBy: string | null
}
export interface AvatarMediaFilter {
  statuses?: readonly string[]
  createdBefore?: Date
  scannedAfter?: Date
  userIds?: readonly string[]
}
export interface OrphanAvatarRef {
  id: string
  key: string
}
// A row of the audit log as the cold export writes it: the same fields, in the order of the model
export interface AuditLogEntry {
  id: string
  action: string
  userId: string | null
  storeId: string | null
  organizationId: string | null
  resourceType: string | null
  resourceId: string | null
  metadata: unknown
  ipAddress: string | null
  userAgent: string | null
  timestamp: Date
}

@Injectable()
export class WorkerLists {
  constructor(private readonly prisma: PrismaService) {}

  enabledScheduledReports(): Promise<ScheduledReportRef[]> {
    return readAllPages(
      async (after, size) => {
        const rows = await this.prisma.client.$queryRaw<{ id: string; store_id: string }[]>`
          SELECT id, store_id FROM rls_list_enabled_scheduled_reports(${after}, ${size})`
        return rows.map(row => ({ id: row.id, storeId: row.store_id }))
      },
      row => row.id
    )
  }

  shipmentPollTargets(filter: ShipmentPollFilter): Promise<ConnectionTarget[]> {
    return readAllPages(
      async (after, size) => {
        const rows = await this.prisma.client.$queryRaw<
          { connection_id: string; store_id: string }[]
        >`SELECT connection_id, store_id FROM rls_list_shipment_poll_targets(${filter.kind}, ${[...filter.statuses]}::text[], ${filter.connectionStatus}, ${after}, ${size})`
        return rows.map(row => ({ connectionId: row.connection_id, storeId: row.store_id }))
      },
      row => row.connectionId
    )
  }

  benefitCloseTargets(connectionStatus: string): Promise<ConnectionTarget[]> {
    return readAllPages(
      async (after, size) => {
        const rows = await this.prisma.client.$queryRaw<
          { connection_id: string; store_id: string }[]
        >`SELECT connection_id, store_id FROM rls_list_benefit_close_targets(${connectionStatus}, ${after}, ${size})`
        return rows.map(row => ({ connectionId: row.connection_id, storeId: row.store_id }))
      },
      row => row.connectionId
    )
  }

  pickupTargets(connectionStatus: string): Promise<PickupTarget[]> {
    return readAllPages(
      async (after, size) => {
        const rows = await this.prisma.client.$queryRaw<{ id: string; store_id: string }[]>`
          SELECT id, store_id FROM rls_list_pickup_targets(${connectionStatus}, ${after}, ${size})`
        return rows.map(row => ({ id: row.id, storeId: row.store_id }))
      },
      row => row.id
    )
  }

  // One batch (the oldest first), not the whole list: the sweep queues one batch a minute, as it always did
  async pickupsPendingStale(filter: PendingPickupFilter): Promise<PickupTarget[]> {
    const rows = await this.prisma.client.$queryRaw<{ id: string; store_id: string }[]>`
      SELECT id, store_id FROM rls_list_pickups_pending_stale(${filter.status}, ${filter.createdBefore}::timestamp, ${filter.dateFrom}::date, ${filter.limit}::integer)`
    return rows.map(row => ({ id: row.id, storeId: row.store_id }))
  }

  async pickupsCountBehind(filter: BehindPickupFilter): Promise<PickupTarget[]> {
    const rows = await this.prisma.client.$queryRaw<{ id: string; store_id: string }[]>`
      SELECT id, store_id FROM rls_list_pickups_count_behind(${[...filter.statuses]}::text[], ${filter.dateFrom}::date, ${filter.updatedBefore}::timestamp, ${filter.limit}::integer)`
    return rows.map(row => ({ id: row.id, storeId: row.store_id }))
  }

  activeChannelConnections(filter: ChannelConnectionFilter): Promise<ChannelConnectionRef[]> {
    return readAllPages(
      async (after, size) => {
        const rows = await this.prisma.client.$queryRaw<
          { id: string; store_id: string; plugin_id: string; updated_at: Date }[]
        >`SELECT id, store_id, plugin_id, updated_at FROM rls_list_active_channel_connections(${[...filter.statuses]}::text[], ${filter.installationStatus}, ${filter.pluginStatus}, ${after}, ${size})`
        return rows.map(row => ({
          id: row.id,
          storeId: row.store_id,
          pluginId: row.plugin_id,
          updatedAt: row.updated_at
        }))
      },
      row => row.id
    )
  }

  // Run by the api and the worker alike (RemoteChannelSync), so the function is granted to both roles
  remoteChannelPlugins(filter: RemoteChannelPluginFilter): Promise<RemoteChannelPluginRef[]> {
    return readAllPages(
      async (after, size) => {
        const rows = await this.prisma.client.$queryRaw<
          { id: string; manifest: unknown; store_ids: string[] }[]
        >`SELECT id, manifest, store_ids FROM rls_list_remote_channel_plugins(${filter.type}, ${filter.status}, ${filter.installationStatus}, ${after}, ${size})`
        return rows.map(row => ({ id: row.id, manifest: row.manifest, storeIds: row.store_ids }))
      },
      row => row.id
    )
  }

  usersWithPendingEmail(): Promise<string[]> {
    return readAllPages(
      async (after, size) => {
        const rows = await this.prisma.client.$queryRaw<{ user_id: string }[]>`
          SELECT user_id FROM rls_list_users_with_pending_email(${after}, ${size})`
        return rows.map(row => row.user_id)
      },
      id => id
    )
  }

  // The audit log (cold export): definers of read only; the only delete is purge_audit_logs
  async auditOldestBefore(before: Date): Promise<Date | null> {
    const rows = await this.prisma.client.$queryRaw<{ oldest: Date | null }[]>`
      SELECT rls_audit_oldest_before(${before}) AS oldest`
    return rows[0]?.oldest ?? null
  }

  async auditCountBetween(start: Date, end: Date): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<{ total: bigint }[]>`
      SELECT rls_audit_count_between(${start}, ${end}) AS total`
    return Number(rows[0]?.total ?? 0)
  }

  // One page of a month by (timestamp, id); the caller walks it until a page is shorter than `size`
  async auditColdPage(
    start: Date,
    end: Date,
    after: { timestamp: Date; id: string } | undefined,
    size: number
  ): Promise<AuditLogEntry[]> {
    const afterTimestamp = after?.timestamp ?? null
    const afterId = after?.id ?? null
    const rows = await this.prisma.client.$queryRaw<
      {
        id: string
        action: string
        user_id: string | null
        store_id: string | null
        organization_id: string | null
        resource_type: string | null
        resource_id: string | null
        metadata: unknown
        ip_address: string | null
        user_agent: string | null
        timestamp: Date
      }[]
    >`SELECT * FROM rls_audit_logs_for_cold_export(${start}, ${end}, ${afterTimestamp}::timestamp, ${afterId}::text, ${size}::integer)`
    return rows.map(row => ({
      id: row.id,
      action: row.action,
      userId: row.user_id,
      storeId: row.store_id,
      organizationId: row.organization_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      metadata: row.metadata,
      ipAddress: row.ip_address,
      userAgent: row.user_agent,
      timestamp: row.timestamp
    }))
  }

  // Avatar media (the one media with no store), by the filters given
  avatarMedia(filter: AvatarMediaFilter): Promise<AvatarMediaRef[]> {
    const statuses = filter.statuses === undefined ? null : [...filter.statuses]
    const userIds = filter.userIds === undefined ? null : [...filter.userIds]
    const createdBefore = filter.createdBefore ?? null
    const scannedAfter = filter.scannedAfter ?? null
    return readAllPages(
      async (after, size) => {
        const rows = await this.prisma.client.$queryRaw<
          {
            id: string
            key: string
            status: string
            created_at: Date
            uploaded_by: string | null
          }[]
        >`SELECT id, key, status, created_at, uploaded_by FROM rls_list_avatar_media(${statuses}::text[], ${createdBefore}::timestamp, ${scannedAfter}::timestamp, ${userIds}::text[], ${after}::text, ${size}::integer)`
        return rows.map(row => ({
          id: row.id,
          key: row.key,
          status: row.status,
          createdAt: row.created_at,
          uploadedBy: row.uploaded_by
        }))
      },
      row => row.id
    )
  }

  orphanAvatars(
    cutoff: Date,
    refusedStatuses: readonly string[],
    userIds?: readonly string[]
  ): Promise<OrphanAvatarRef[]> {
    const users = userIds === undefined ? null : [...userIds]
    return readAllPages(
      async (after, size) =>
        this.prisma.client.$queryRaw<OrphanAvatarRef[]>`
          SELECT id, key FROM rls_list_orphan_avatars(${cutoff}::timestamp, ${[...refusedStatuses]}::text[], ${users}::text[], ${after}::text, ${size}::integer)`,
      row => row.id
    )
  }

  // The key of the object to delete, or null when the row stayed (it is held, attached, or no longer an avatar)
  async clearOrphanAvatar(mediaId: string, cutoff: Date): Promise<string | null> {
    const rows = await this.prisma.client.$queryRaw<{ key: string | null }[]>`
      SELECT rls_clear_orphan_avatar(${mediaId}::text, ${cutoff}::timestamp) AS key`
    return rows[0]?.key ?? null
  }

  async avatarMediaKeys(ids: readonly string[]): Promise<{ id: string; key: string }[]> {
    if (ids.length === 0) return []
    return this.prisma.client.$queryRaw<{ id: string; key: string }[]>`
      SELECT id, key FROM rls_avatar_media_keys(${[...ids]}::text[])`
  }
}
