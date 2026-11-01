import { BlockList, isIP } from 'node:net'

// Where a server-side fetch must never go: the machine itself, the private networks, link-local
// (the cloud metadata address is 169.254.169.254), carrier-grade NAT, documentation and multicast.
const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24], // AS112
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 96], // the unspecified address, the loopback and the IPv4-compatible form
  ['::ffff:0:0:0', 96], // SIIT: an IPv4 address inside
  ['64:ff9b::', 96], // NAT64: carries an IPv4 address that is not checked here
  ['100::', 64],
  ['2001::', 32], // Teredo: an IPv4 address inside
  ['2002::', 16], // 6to4: an IPv4 address inside
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6')
}

const MAPPED_V4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i

// True only for an address that is on the public internet. Anything that is not an IP is not one.
export function isPublicAddress(address: string): boolean {
  const mapped = MAPPED_V4.exec(address)
  const target = mapped?.[1] ?? address
  const family = isIP(target)
  if (family === 0) return false
  return !blocked.check(target, family === 4 ? 'ipv4' : 'ipv6')
}
