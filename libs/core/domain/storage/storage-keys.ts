export const ImageVariants = { FULL: 'full', MEDIUM: 'medium', THUMB: 'thumb' } as const
export type ImageVariant = (typeof ImageVariants)[keyof typeof ImageVariants]

// The ONLY place S3 keys are built (TDD_01 §2.3).
export const StorageKeys = {
  message: (storeId: string, mediaId: string, filename: string) =>
    `stores/${storeId}/messages/${mediaId}/${filename}`,
  // Where a client PUTs a file for a message. Confirming copies it to `message(...)`: the signed URL
  // stays valid for its TTL after the confirmation, so the object a client can still overwrite is
  // never the one that is scanned and served.
  messageUpload: (storeId: string, mediaId: string, filename: string) =>
    `stores/${storeId}/uploads/${mediaId}/${filename}`,
  messageVariant: (storeId: string, mediaId: string, variant: ImageVariant) =>
    `stores/${storeId}/messages/${mediaId}/variants/${variant}.webp`,
  product: (storeId: string, productId: string, mediaId: string, filename: string) =>
    `stores/${storeId}/products/${productId}/${mediaId}/${filename}`,
  order: (storeId: string, orderId: string, mediaId: string, filename: string) =>
    `stores/${storeId}/orders/${orderId}/${mediaId}/${filename}`,
  export: (storeId: string, exportId: string, filename: string) =>
    `stores/${storeId}/exports/${exportId}/${filename}`,
  avatar: (userId: string, mediaId: string, filename: string) =>
    `users/${userId}/avatar/${mediaId}/${filename}`,
  dsrExport: (requestId: string) => `compliance/dsr/${requestId}/export.zip`,
  auditArchive: (year: number, month: number) =>
    `audit/${year}/${String(month).padStart(2, '0')}/audit-logs.jsonl.gz`,
  storePrefix: (storeId: string) => `stores/${storeId}/`
} as const
