import { API_PREFIX, ApiRoutes } from '@platform/core/api'
import { signUnsubscribeToken, UnsubscribeScopes } from '@platform/core/crypto'
import { AppPaths } from '@platform/core/domain'
import {
  UNSUBSCRIBE_TOKEN_PARAM,
  type UnsubscribeLinks,
  type UnsubscribeLinkSet
} from '@platform/core/notifications'

// The links of the unsubscribe of the notification emails, signed with the key in force (never the previous key: that one only verifies)
export function buildUnsubscribeLinks(input: {
  frontendUrl: string
  apiUrl: string
  signingKey: string
}): UnsubscribeLinks {
  return {
    forUser(userId: string): UnsubscribeLinkSet {
      const token = signUnsubscribeToken(
        input.signingKey,
        UnsubscribeScopes.NOTIFICATION_EMAIL,
        userId
      )
      const page = new URL(AppPaths.unsubscribe, input.frontendUrl)
      page.hash = `${UNSUBSCRIBE_TOKEN_PARAM}=${token}`
      const post = new URL(`${API_PREFIX}${ApiRoutes.notifications.unsubscribe}`, input.apiUrl)
      post.searchParams.set(UNSUBSCRIBE_TOKEN_PARAM, token)
      return { pageUrl: page.toString(), postUrl: post.toString() }
    }
  }
}
