import { ApiRoutes } from '@platform/core/api'

import type { ApiClient } from './api-client'
import { teamPresenceSchema, type UserPresenceView } from './api-schemas'

export function fetchTeamPresence(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<UserPresenceView[]> {
  return client.request(ApiRoutes.presence.team, {
    schema: teamPresenceSchema,
    storeId,
    signal
  })
}
