export const MediaPurpose = {
  MESSAGE: 'message',
  // The picture of the ad a conversation came from
  ORIGIN: 'origin',
  PRODUCT: 'product',
  ORDER: 'order',
  AVATAR: 'avatar',
  EXPORT: 'export',
  SHIPPING_LABEL: 'shipping_label',
  BULK_LABELS: 'bulk_labels',
  REMITTANCE_FILE: 'remittance_file'
} as const
export type MediaPurposeType = (typeof MediaPurpose)[keyof typeof MediaPurpose]
