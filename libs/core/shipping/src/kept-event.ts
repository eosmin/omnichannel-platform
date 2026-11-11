// A history line that was kept with no status (TDD_17 §4.17) carries, in its payload, the normalized parts of the code the carrier
// used: the code under which it is looked up (composite when there is a reason), the plain status and the reason. The writer (the
// worker that keeps the line), the replay that reads it and the count of what waits for the owner all go through this file, so the
// three can never disagree on a key.
export const KeptEventPayloadKeys = {
  PROVIDER_CODE: 'providerCode',
  PLAIN_CODE: 'plainCode',
  REASON_CODE: 'reasonCode'
} as const

export interface KeptCode {
  plainCode: string
  reasonCode?: string | undefined
}

export function keptEventPayload(providerCode: string, code: KeptCode): Record<string, string> {
  return {
    [KeptEventPayloadKeys.PROVIDER_CODE]: providerCode,
    [KeptEventPayloadKeys.PLAIN_CODE]: code.plainCode,
    ...(code.reasonCode === undefined
      ? {}
      : { [KeptEventPayloadKeys.REASON_CODE]: code.reasonCode })
  }
}

// The normalized parts of the code a line was kept under; a payload this layer did not write gives none and the line is left alone
export function keptCodeOf(payload: unknown): KeptCode | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const plain: unknown = Reflect.get(payload, KeptEventPayloadKeys.PLAIN_CODE)
  const reason: unknown = Reflect.get(payload, KeptEventPayloadKeys.REASON_CODE)
  if (typeof plain !== 'string' || plain === '') return null
  return typeof reason === 'string' && reason !== ''
    ? { plainCode: plain, reasonCode: reason }
    : { plainCode: plain }
}

// The lines kept under a code or under one of its reasons (`16` covers `16:115`), as the filter of a query on their payload
export interface KeptCodeFilter {
  payload: { path: string[]; equals?: string; string_starts_with?: string }
}

export function keptCodeFilter(providerCode: string): KeptCodeFilter[] {
  const path: string[] = [KeptEventPayloadKeys.PROVIDER_CODE]
  return [
    { payload: { path, equals: providerCode } },
    { payload: { path, string_starts_with: `${providerCode}:` } }
  ]
}
