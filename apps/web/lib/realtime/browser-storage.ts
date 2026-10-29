// localStorage can throw on access (blocked site data, some private modes, sandboxed frames). The
// queue keeps its copy in memory when the storage does nothing, so a page without storage still works.
export function safeLocalStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  try {
    return window.localStorage
  } catch {
    return { getItem: () => null, setItem: () => undefined }
  }
}
