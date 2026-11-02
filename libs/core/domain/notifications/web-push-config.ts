export interface WebPushConfig {
  // null while the VAPID keys are not configured: the push is then skipped, never an error
  vapid: { subject: string; publicKey: string; privateKey: string } | null
}

export const WEB_PUSH_CONFIG = Symbol('WEB_PUSH_CONFIG')

// "Name <address>" or a bare address: the contact the push services may write to is the address
const ADDRESS_IN_BRACKETS = /<([^<>\s]+)>\s*$/

export function webPushConfig(source: {
  EMAIL_FROM: string
  VAPID_PUBLIC_KEY?: string | undefined
  VAPID_PRIVATE_KEY?: string | undefined
}): WebPushConfig {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = source
  if (publicKey === undefined || privateKey === undefined) return { vapid: null }
  const trimmed = source.EMAIL_FROM.trim()
  const address = ADDRESS_IN_BRACKETS.exec(trimmed)?.[1] ?? trimmed
  return { vapid: { subject: `mailto:${address}`, publicKey, privateKey } }
}
