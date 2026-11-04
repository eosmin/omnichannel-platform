import { generateKeyPairSync } from 'node:crypto'

export interface VapidPair {
  publicKey: string
  privateKey: string
}

// A P-256 key pair in the form web push wants: the public key is the uncompressed point (0x04, x, y:
// 65 bytes) and the private key is the 32-byte scalar, both base64url without padding. It is what
// `web-push generate-vapid-keys` makes; the spec proves that web-push accepts it. Made here because
// web-push is a CommonJS package that the ESM scripts cannot import by name.
export function generateVapidPair(): VapidPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const { x, y } = publicKey.export({ format: 'jwk' })
  const { d } = privateKey.export({ format: 'jwk' })
  if (x === undefined || y === undefined || d === undefined) {
    throw new Error('the key pair has no coordinates')
  }
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(x, 'base64url'),
    Buffer.from(y, 'base64url')
  ])
  return { publicKey: point.toString('base64url'), privateKey: d }
}

// What `pnpm vapid:generate` prints. The pair goes to the terminal only: no file is written, so a
// key never lands in the working tree (the repository is public). The three assignments carry no
// quotes and no angle brackets, so they can be pasted into any .env file as they are.
export function vapidReport({ publicKey, privateKey }: VapidPair): string {
  return `A new VAPID key pair for web push. Nothing was written to disk.

Paste these into .env.local (the api and the worker read them; both restart to pick them up):

VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${privateKey}

Paste this into apps/web/.env.local, then rebuild or restart the web app: a NEXT_PUBLIC_ variable
is read when the web is built, not when it runs (next dev picks it up on restart):

NEXT_PUBLIC_VAPID_PUBLIC_KEY=${publicKey}

The private key is a secret: never commit it, never paste it in a chat or an issue. The public key is
not secret. Make a new pair and replace all three if the private one leaks (every browser that
subscribed with the old public key is then asked to subscribe again).
`
}
