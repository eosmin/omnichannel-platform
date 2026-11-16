// Why the check of the chain says it is broken: the five the api names (TDD_18 §11). A reason the screen does not know (a newer api)
// is drawn with the generic text, never as a raw code.
export const KnownChainReasons = [
  'number_gap',
  'prev_hash_mismatch',
  'hash_mismatch',
  'head_mismatch',
  'frozen_head_missing'
] as const
export type KnownChainReason = (typeof KnownChainReasons)[number]

export const knownChainReason = (reason: string): KnownChainReason | null =>
  (KnownChainReasons as readonly string[]).includes(reason) ? (reason as KnownChainReason) : null
