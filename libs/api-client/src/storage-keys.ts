// Browser localStorage keys. Not to be confused with the S3 StorageKeys of @platform/core/storage.
export const StorageKeys = {
  LAST_STORE_ID: 'platform_last_store_id', // "/" redirects to the last store (TDD_09 §12)
  SIDEBAR_COLLAPSED: 'platform_sidebar_collapsed',
  SIDEBAR_WIDGETS: 'platform_sidebar_widgets',
  COMPOSER_DRAFT: 'platform_composer_draft', // Prefix of the unsent text of a conversation, in sessionStorage
  PENDING_MESSAGES: 'platform_pending_messages', // The offline send queue (TDD_06 §4)
  PUSH_OFFERED: 'platform_push_offered', // The push prompt was shown in this browser (TDD_06 §7.3)
  PUSH_TURNED_OFF: 'platform_push_turned_off', // The person switched push off on this browser: no silent re-subscribe
  COUNT_DRAFT: 'platform_count_draft', // Prefix of the quantities typed on a count sheet that the api has not confirmed yet, by count (localStorage)
  LANGUAGE_SAVED: 'platform_language_saved' // sessionStorage: the language just saved, to confirm in it once the page is drawn again
} as const
export type StorageKey = (typeof StorageKeys)[keyof typeof StorageKeys]

// The cookie that carries the language of the interface, so that the server renders in it
export const LOCALE_COOKIE = 'platform_locale'
