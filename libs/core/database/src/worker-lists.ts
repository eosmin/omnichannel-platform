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
}
