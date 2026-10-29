import { StorageKeys } from '@platform/api-client'

// localStorage can be missing or throw (private windows, blocked site data): the page works without it
export function readLastStoreId(): string | null {
  try {
    return window.localStorage.getItem(StorageKeys.LAST_STORE_ID)
  } catch {
    return null
  }
}

export function rememberLastStoreId(storeId: string): void {
  try {
    window.localStorage.setItem(StorageKeys.LAST_STORE_ID, storeId)
  } catch {
    // Not remembering the store is harmless: "/" goes to the first one
  }
}
