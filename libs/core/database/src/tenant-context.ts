// What a unit of work may see once Row-Level Security is on (Step 7.1): the stores and the
// organizations of the caller, and the person when the work is theirs (an avatar, a notification of
// several stores). All of it becomes transaction-local settings, see PrismaService.
export interface TenantContext {
  storeIds: readonly string[]
  organizationIds: readonly string[]
  // The person the work acts for: `app.user_id`, read by the policies of the rows that belong to a person. Empty when the work
  // is not a person's (a job of a store)
  userId?: string | undefined
}

// The switch of Row-Level Security for the requests of the api (`RLS_CONTEXT`): a provider token, so that the interceptor reads a
// boolean and not the environment. It lives here, with no import of the env, so that a unit spec can build the interceptor; the
// module that provides it (RlsContextPlatformModule) reads the validated env.
export const RLS_CONTEXT_ENABLED = Symbol('RLS_CONTEXT_ENABLED')
