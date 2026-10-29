import { randomInt } from 'node:crypto'

export const FORWARDED_FOR = 'x-forwarded-for'

const OCTET_RANGE = 256
const HOST_OCTET_MAX = 254

// The rate limits of the api count per address (five links a minute, three accepted invitations an
// hour), and every spec comes from this machine. The api runs behind one proxy (TRUST_PROXY_HOPS=1),
// as it does where it is deployed, so each test says it is somebody else.
export function newClientIp(): string {
  return `10.${randomInt(OCTET_RANGE)}.${randomInt(OCTET_RANGE)}.${randomInt(1, HOST_OCTET_MAX)}`
}
