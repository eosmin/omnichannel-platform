// The permissions a login asked for against the ones the provider says it granted. Pure: no call is made here.
// What was asked for and is not granted, in the order it was asked. The dialog lets a person clear any box,
// so this is what turns "the provider answered with an error" into "grant this permission".
export function missingOAuthScopes(
  required: readonly string[],
  granted: readonly string[]
): string[] {
  const have = new Set(granted)
  return required.filter(scope => !have.has(scope))
}
