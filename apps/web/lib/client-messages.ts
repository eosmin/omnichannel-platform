// The namespaces of the message files that only the server reads: the mail templates are rendered by the worker (and the api), never by a
// component of the browser, so they do not travel in the script of every page. `getTranslations` on the server still reads the whole file.
export const SERVER_ONLY_MESSAGE_NAMESPACES = ['email'] as const

export function clientMessagesOf(messages: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(messages).filter(
      ([namespace]) => !(SERVER_ONLY_MESSAGE_NAMESPACES as readonly string[]).includes(namespace)
    )
  )
}
