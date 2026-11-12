'use client'

import dynamic from 'next/dynamic'

// The detail panels are drawn on a press: they stay out of the bundle of the list pages until then
export const LazyShipmentDetail = dynamic(
  () => import('../../components/shipping/shipment-detail').then(module => module.ShipmentDetail),
  { ssr: false }
)

export const LazyPickupDetail = dynamic(
  () => import('../../components/shipping/pickup-detail').then(module => module.PickupDetail),
  { ssr: false }
)

export const LazyPickupRequest = dynamic(
  () =>
    import('../../components/shipping/pickup-request-dialog').then(
      module => module.PickupRequestDialog
    ),
  { ssr: false }
)
