// What the log of a delivery says when it failed: a code of `WebhookDeliveryErrors`, and for a network error the code of Node
// after a colon ("no_answer:ECONNRESET"). The page translates the first and shows the second as it is, for the person who
// reads the log of their own endpoint.
export function deliveryErrorCode(error: string): { code: string; detail: string | null } {
  const colon = error.indexOf(':')
  if (colon === -1) return { code: error, detail: null }
  const detail = error.slice(colon + 1).trim()
  return { code: error.slice(0, colon), detail: detail === '' ? null : detail }
}
