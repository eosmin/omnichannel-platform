import { ChannelIds } from './channel-ids'
import { ChannelOAuthLimits, MetaOAuth, MetaOAuthScopes } from './channel-oauth-constants'

// Pure helpers over the permissions of "Connect with Facebook". No call to Meta is made here: the plugin
// asks the Graph, and these decide what to ask for and what is missing from the answer.

// What a login for each channel asks for. Messenger needs the Page ones and the portfolio one; Instagram,
// which goes through the same Page, adds its own two. Any other id (WhatsApp, the widget, a third party's)
// has no login, so it asks for nothing.
export function metaOAuthScopesFor(pluginId: string): readonly string[] {
  const page = [
    MetaOAuthScopes.PAGES_SHOW_LIST,
    MetaOAuthScopes.PAGES_MESSAGING,
    MetaOAuthScopes.PAGES_MANAGE_METADATA,
    MetaOAuthScopes.PAGES_READ_ENGAGEMENT,
    MetaOAuthScopes.BUSINESS_MANAGEMENT
  ]
  if (pluginId === ChannelIds.MESSENGER) return page
  if (pluginId === ChannelIds.INSTAGRAM) {
    return [...page, MetaOAuthScopes.INSTAGRAM_BASIC, MetaOAuthScopes.INSTAGRAM_MANAGE_MESSAGES]
  }
  return []
}

// The value of the `scope` parameter of the dialog. Every name is checked, because the result goes into an
// address: a name with a comma, an ampersand or a space would add a parameter of the caller's choosing.
export function metaOAuthScopeParam(scopes: readonly string[]): string {
  if (scopes.length === 0 || scopes.length > ChannelOAuthLimits.MAX_SCOPES) {
    throw new Error('the login must ask for between one and the maximum number of scopes')
  }
  if (new Set(scopes).size !== scopes.length) {
    throw new Error('a scope of the login is repeated')
  }
  for (const scope of scopes) {
    if (!MetaOAuth.SCOPE_PATTERN.test(scope)) {
      throw new Error('a scope of the login is not a permission name')
    }
  }
  return scopes.join(MetaOAuth.SCOPE_SEPARATOR)
}

// The permissions that `GET me/permissions` says are granted. An answer that is not the shape of the Graph
// (a proxy page, a change of Meta's) reads as nothing granted, which fails closed: the person is told what to
// grant instead of the connection going on without knowing.
export function grantedMetaScopes(answer: unknown): string[] {
  if (typeof answer !== 'object' || answer === null) return []
  const data: unknown = (answer as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const granted: string[] = []
  for (const entry of data as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const { permission, status } = entry as Record<string, unknown>
    if (
      typeof permission === 'string' &&
      MetaOAuth.SCOPE_PATTERN.test(permission) &&
      status === MetaOAuth.PERMISSION_GRANTED
    ) {
      granted.push(permission)
    }
  }
  return granted
}

// What was asked for and is not granted, in the order it was asked. The dialog lets a person clear any box,
// so this is what turns "Meta answered error 100" into "grant pages_read_engagement".
export function missingOAuthScopes(
  required: readonly string[],
  granted: readonly string[]
): string[] {
  const have = new Set(granted)
  return required.filter(scope => !have.has(scope))
}
