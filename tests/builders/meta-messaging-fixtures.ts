// Webhook bodies in the shape Meta documents for Messenger and Instagram messaging (the same envelope
// on two objects), with made-up ids. They come from Meta's reference, not from a real account yet: a
// box in Step 7.3 swaps them for captured ones.
export const MESSAGING_CUSTOMER = '1234567890123456'
export const MESSAGING_TIMESTAMP = 1_761_600_000_000

export function messagingWebhook(object: string, accountId: string, ...items: object[]): object {
  return { object, entry: [{ id: accountId, time: MESSAGING_TIMESTAMP, messaging: items }] }
}

export function inboundText(accountId: string, text: string): object {
  return {
    sender: { id: MESSAGING_CUSTOMER },
    recipient: { id: accountId },
    timestamp: MESSAGING_TIMESTAMP,
    message: { mid: 'mid.$cAAJdkrCd2ORnva8ErFhjGm0X_Q_c', text }
  }
}
