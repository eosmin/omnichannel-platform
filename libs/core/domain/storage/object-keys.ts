import { StorageKeys } from './storage-keys'

// The keys of the files a media row owns: its original and each variant the pipeline made. Only keys under the
// store's own prefix are named in `keys`, so a variants column that was written wrong can never point a delete at the
// files of another store; the others come back in `foreign` so the caller can say that they were left.
export function objectKeysOf(
  storeId: string,
  media: { key: string; variants: unknown }
): { keys: string[]; foreign: string[] } {
  const prefix = StorageKeys.storePrefix(storeId)
  const all = new Set<string>([media.key])
  if (typeof media.variants === 'object' && media.variants !== null) {
    for (const value of Object.values(media.variants)) {
      if (typeof value === 'string') all.add(value)
    }
  }
  const keys: string[] = []
  const foreign: string[] = []
  for (const key of all) (key.startsWith(prefix) ? keys : foreign).push(key)
  return { keys, foreign }
}
