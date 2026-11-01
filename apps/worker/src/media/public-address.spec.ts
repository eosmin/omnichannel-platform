import { isPublicAddress } from './public-address'

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '157.240.1.35', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'accepts %s',
    address => {
      expect(isPublicAddress(address)).toBe(true)
    }
  )

  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '198.18.0.1',
    '192.31.196.5',
    '192.88.99.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '64:ff9b::7f00:1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::7f00:1',
    '::ffff:0:7f00:1',
    '2002:7f00:1::',
    '2002:a9fe:a9fe::',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2'
  ])('refuses %s', address => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it('refuses what is not an address', () => {
    expect(isPublicAddress('localhost')).toBe(false)
    expect(isPublicAddress('')).toBe(false)
    expect(isPublicAddress('0x7f.1')).toBe(false)
  })
})
