'use client'

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  type CarrierConnectionView,
  cancelOrderShipment,
  createOrderShipment,
  fetchAllCarrierConnections,
  fetchOrderShipments,
  fetchShipmentLabelLink,
  markOrderShipmentVoided,
  type OrderShipmentView,
  QueryKeys,
  type ShipmentLabelLinkView
} from '@platform/api-client'
import type { CreateShipmentBody } from '@platform/core/domain'

import { apiClient } from '../api'

// The connections of the store, for the dialogs that make a guide: the cache is the one of Settings → Carriers, so a connection
// edited there is read again here. Reading them asks for shipping:view.
export function useGuideConnections(
  storeId: string,
  enabled: boolean
): UseQueryResult<CarrierConnectionView[]> {
  return useQuery({
    queryKey: QueryKeys.carriers.list(storeId),
    queryFn: ({ signal }) => fetchAllCarrierConnections(apiClient, storeId, signal),
    enabled
  })
}

// The guides of one order, newest first. Reading them asks for shipping:view.
export function useOrderShipments(
  storeId: string,
  orderId: string,
  enabled: boolean
): UseQueryResult<OrderShipmentView[]> {
  return useQuery({
    queryKey: QueryKeys.shipments.byOrder(storeId, orderId),
    queryFn: ({ signal }) => fetchOrderShipments(apiClient, storeId, orderId, signal),
    enabled
  })
}

export interface ShipmentWrites {
  create: UseMutationResult<OrderShipmentView, Error, CreateShipmentBody>
  cancel: UseMutationResult<OrderShipmentView, Error, string>
  markVoided: UseMutationResult<OrderShipmentView, Error, string>
  // A link good for minutes, asked when the button is pressed and never kept
  label: UseMutationResult<ShipmentLabelLinkView, Error, string>
}

// A guide that is voided changes the order's detail (its tracking number) and the lists, so each move refreshes the guides of the
// order, the order and the lists. A move the api refuses leaves the screen as it was.
export function useShipmentWrites(storeId: string, orderId: string): ShipmentWrites {
  const queryClient = useQueryClient()
  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: QueryKeys.shipments.all(storeId) }),
      queryClient.invalidateQueries({ queryKey: QueryKeys.orders.byId(storeId, orderId) }),
      queryClient.invalidateQueries({ queryKey: [...QueryKeys.orders.all(storeId), 'list'] })
    ])
  }
  return {
    create: useMutation({
      mutationFn: (body: CreateShipmentBody) =>
        createOrderShipment(apiClient, storeId, orderId, body),
      onSuccess: refresh
    }),
    cancel: useMutation({
      mutationFn: (shipmentId: string) => cancelOrderShipment(apiClient, storeId, shipmentId),
      onSuccess: refresh
    }),
    markVoided: useMutation({
      mutationFn: (shipmentId: string) => markOrderShipmentVoided(apiClient, storeId, shipmentId),
      onSuccess: refresh
    }),
    label: useMutation({
      mutationFn: (shipmentId: string) => fetchShipmentLabelLink(apiClient, storeId, shipmentId)
    })
  }
}
