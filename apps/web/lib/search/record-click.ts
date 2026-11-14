import { recordSearchClick, type SearchClick } from '@platform/api-client'

import { apiClient } from '../api'

// Tells the api which result a person opened, for the report of what was searched. It is fire and forget: opening the
// result never waits for it and never shows an error for it, and a click that did not arrive is a click not counted.
export function recordClick(storeId: string, click: SearchClick): void {
  void recordSearchClick(apiClient, storeId, click).catch(() => undefined)
}
