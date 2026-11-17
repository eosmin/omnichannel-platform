// Checks, on the owner's own machine, that a signing certificate of the tax authority of El Salvador has the format this platform could
// sign with by itself (Step 4B.7c-3, option C), without printing anything secret: no key, no password, no hash of it.
//
// Usage (the password goes by the environment, never by an argument that the shell keeps):
//   SV_CERT_PASSWORD='the password of the private key' pnpm tsx scripts/check-sv-certificate.ts /path/to/12345678901234.crt
//
// What it says: whether the file has the fields of the certificate (XML with a private key in base64 and the hash of its password), whether
// the password is the one the file expects (SHA-512, how the official signing service checks it), whether the key is a PKCS#8 RSA key that
// Node can use, and whether a test signature with it (RS512, the algorithm of the authority) verifies.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { argv, env, exit } from 'node:process'

const path = argv[2]
const password = env['SV_CERT_PASSWORD']
if (path === undefined || password === undefined || password === '') {
  console.error('usage: SV_CERT_PASSWORD=... pnpm tsx scripts/check-sv-certificate.ts <file.crt>')
  exit(2)
}

const xml = readFileSync(path, 'utf8')
const tag = (source: string, name: string): string | null => {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(source)
  return found?.[1]?.trim() ?? null
}
const privateKeyBlock = tag(xml, 'privateKey')
const encoded = privateKeyBlock === null ? null : tag(privateKeyBlock, 'encodied')
const expectedHash = privateKeyBlock === null ? null : tag(privateKeyBlock, 'clave')
const algorithm = privateKeyBlock === null ? null : tag(privateKeyBlock, 'algorithm')
const format = privateKeyBlock === null ? null : tag(privateKeyBlock, 'format')
const nit = tag(xml, 'nit')

const report: Record<string, unknown> = {
  hasPrivateKeyBlock: privateKeyBlock !== null,
  hasEncodedKey: encoded !== null,
  hasPasswordHash: expectedHash !== null,
  algorithm,
  format,
  nitMatchesFileName: nit !== null && basename(path).startsWith(nit)
}

report['passwordMatches'] =
  expectedHash !== null &&
  createHash('sha512').update(password, 'utf8').digest('hex').toLowerCase() ===
    expectedHash.toLowerCase()

try {
  if (encoded === null) throw new Error('no key')
  const key = createPrivateKey({
    key: Buffer.from(encoded, 'base64'),
    format: 'der',
    type: 'pkcs8'
  })
  report['keyType'] = key.asymmetricKeyType
  report['keyBits'] = key.asymmetricKeyDetails?.modulusLength ?? null
  const payload = 'platform-check'
  const signature = createSign('RSA-SHA512').update(payload).sign(key)
  report['signatureVerifies'] = createVerify('RSA-SHA512')
    .update(payload)
    .verify(createPublicKey(key), signature)
} catch {
  report['keyType'] = null
  report['signatureVerifies'] = false
}

console.log(JSON.stringify(report, null, 2))
exit(report['passwordMatches'] === true && report['signatureVerifies'] === true ? 0 : 1)
