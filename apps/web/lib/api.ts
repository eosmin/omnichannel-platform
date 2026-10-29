import { createApiClient, createBrowserSession } from '@platform/api-client'

import { webEnv } from './env'

// One session and one client for the whole page: the access token lives in this module's memory
export const browserSession = createBrowserSession()

export const apiClient = createApiClient({
  baseUrl: webEnv.NEXT_PUBLIC_API_URL,
  getAccessToken: browserSession.getAccessToken,
  refreshAccessToken: browserSession.refresh
})
