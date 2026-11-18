// The conversations this tab deleted. The event of the deletion reaches this client too, and the person already
// has the answer of their own action (a toast and the way out of the thread): the watcher does not say it twice.
const deletedHere = new Set<string>()

export function markDeletedHere(conversationId: string): void {
  deletedHere.add(conversationId)
}

export function wasDeletedHere(conversationId: string): boolean {
  return deletedHere.has(conversationId)
}
