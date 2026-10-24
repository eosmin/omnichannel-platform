// Browser localStorage keys. Not to be confused with the S3 StorageKeys of @platform/core/storage.
export const StorageKeys = {
  LAST_STORE_ID: 'platform_last_store_id', // "/" redirects to the last store (TDD_09 §12)
  SIDEBAR_COLLAPSED: 'platform_sidebar_collapsed',
  SIDEBAR_WIDGETS: 'platform_sidebar_widgets',
  PENDING_MESSAGES: 'platform_pending_messages' // The offline send queue (TDD_06 §4)
} as const
export type StorageKey = (typeof StorageKeys)[keyof typeof StorageKeys]
