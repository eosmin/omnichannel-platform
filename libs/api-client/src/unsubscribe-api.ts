import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import { UNSUBSCRIBE_TOKEN_PARAM } from '@platform/core/notifications'

import type { ApiClient } from './api-client'

// The one-click unsubscribe of the notification emails (Step 7.3, B6b-3b2b). Public: no session and no store, so it never asks for a refresh. The
// token is in the body, never in the URL of this request. The api answers 204 whatever the token was (nothing says whether it held), so
// the page says "done" for every answer that is not a failure to reach the server
export function unsubscribeFromNotificationEmails(
  client: ApiClient,
  token: string,
  signal?: AbortSignal
): Promise<undefined> {
  return client.request(ApiRoutes.notifications.unsubscribe, {
    method: 'POST',
    body: { [UNSUBSCRIBE_TOKEN_PARAM]: token },
    schema: z.undefined(),
    authenticated: false,
    signal
  })
}
