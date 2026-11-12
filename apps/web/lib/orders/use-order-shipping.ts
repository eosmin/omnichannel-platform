'use client'

import { keepPreviousData, useQuery } from '@tanstack/react-query'

import {
  fetchAllCarrierConnections,
  fetchShipmentsForOrders,
  QueryKeys,
  type ShipmentSummaryView
} from '@platform/api-client'

import { apiClient } from '../api'

import type { BulkConnection } from './order-bulk'

const NONE: readonly never[] = []

// The guides of the orders on the screen, for the guide and carrier columns and for the actions that start from a guide.
// Without `shipping:view` nothing is asked and the columns are not drawn.
export function useOrderShipments(
  storeId: string,
  orderIds: readonly string[],
  enabled: boolean
): readonly ShipmentSummaryView[] {
  const query = useQuery({
    queryKey: QueryKeys.shipments.forOrders(storeId, orderIds),
    queryFn: ({ signal }) => fetchShipmentsForOrders(apiClient, storeId, orderIds, signal),
    enabled: enabled && orderIds.length > 0,
    placeholderData: keepPreviousData
  })
  return query.data?.data ?? NONE
}

// The connections of the store: their names for the filter and the column, and what each can do
export function useCarrierConnections(
  storeId: string,
  enabled: boolean
): readonly BulkConnection[] {
  const query = useQuery({
    queryKey: QueryKeys.carriers.list(storeId),
    queryFn: ({ signal }) => fetchAllCarrierConnections(apiClient, storeId, signal),
    enabled
  })
  return query.data ?? NONE
}
