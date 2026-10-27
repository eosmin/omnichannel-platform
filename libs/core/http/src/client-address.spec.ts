import { clientAddress } from './client-address'

describe('clientAddress', () => {
  it('is the address of the connection when no proxy is in front', () => {
    expect(clientAddress({ 'x-forwarded-for': '1.1.1.1' }, '10.0.0.5', 0)).toBe('10.0.0.5')
  })

  it('is the entry that the one proxy in front added, which the client could not write', () => {
    // The client wrote 6.6.6.6 itself; the proxy appended the address it saw
    expect(clientAddress({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, '10.0.0.5', 1)).toBe(
      '203.0.113.9'
    )
  })

  it('counts from the right as many proxies as there are', () => {
    const headers = { 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.1.1.1' }

    expect(clientAddress(headers, '10.0.0.5', 2)).toBe('203.0.113.9')
  })

  it('falls back to the connection when the header is missing or shorter than the proxies', () => {
    expect(clientAddress({}, '10.0.0.5', 1)).toBe('10.0.0.5')
    expect(clientAddress({ 'x-forwarded-for': '203.0.113.9' }, '10.0.0.5', 2)).toBe('10.0.0.5')
  })

  it('reads a header that came in several lines as one chain', () => {
    expect(clientAddress({ 'x-forwarded-for': ['6.6.6.6', '203.0.113.9'] }, '10.0.0.5', 1)).toBe(
      '203.0.113.9'
    )
  })
})
