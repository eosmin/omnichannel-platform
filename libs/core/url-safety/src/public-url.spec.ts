import {
  assertPublicHttpsUrl,
  isWellFormedPublicHttpsUrl,
  resolvePublicHttpsUrl,
  UnsafeUrlError
} from './public-url'

const resolvesTo =
  (...addresses: string[]) =>
  (): Promise<string[]> =>
    Promise.resolve(addresses)

describe('assertPublicHttpsUrl', () => {
  it('accepts an https link whose host is public', async () => {
    const url = await assertPublicHttpsUrl('https://cdn.example.com/a.jpg', resolvesTo('8.8.8.8'))
    expect(url.hostname).toBe('cdn.example.com')
  })

  it('accepts a public ip literal without resolving it', async () => {
    const resolve = jest.fn()
    await expect(assertPublicHttpsUrl('https://8.8.8.8/a.jpg', resolve)).resolves.toBeInstanceOf(
      URL
    )
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each([
    'http://cdn.example.com/a.jpg',
    'ftp://cdn.example.com/a.jpg',
    'https://user:pass@cdn.example.com/a.jpg',
    'https://cdn.example.com:8443/a.jpg',
    'not a url',
    'https://127.0.0.1/a.jpg',
    'https://[::1]/a.jpg',
    'https://169.254.169.254/latest/meta-data',
    'https://[::ffff:10.0.0.1]/a.jpg'
  ])('refuses %s', async raw => {
    await expect(assertPublicHttpsUrl(raw, resolvesTo('8.8.8.8'))).rejects.toBeInstanceOf(
      UnsafeUrlError
    )
  })

  it('refuses a host that resolves to a private address, even next to a public one', async () => {
    await expect(
      assertPublicHttpsUrl('https://evil.example.com/a.jpg', resolvesTo('8.8.8.8', '10.0.0.5'))
    ).rejects.toBeInstanceOf(UnsafeUrlError)
  })

  it('refuses a host that resolves to nothing', async () => {
    await expect(
      assertPublicHttpsUrl('https://nowhere.example.com/a.jpg', resolvesTo())
    ).rejects.toBeInstanceOf(UnsafeUrlError)
  })
})

describe('resolvePublicHttpsUrl', () => {
  it('returns the addresses the check read, for the caller to connect to', async () => {
    const target = await resolvePublicHttpsUrl(
      'https://cdn.example.com/a.jpg',
      resolvesTo('8.8.8.8', '1.1.1.1')
    )
    expect(target.addresses).toEqual(['8.8.8.8', '1.1.1.1'])
    expect(target.url.hostname).toBe('cdn.example.com')
  })

  it('returns a public ip literal as its own address', async () => {
    const target = await resolvePublicHttpsUrl('https://8.8.8.8/a.jpg', jest.fn())
    expect(target.addresses).toEqual(['8.8.8.8'])
  })

  it('refuses a host with one private address among public ones', async () => {
    await expect(
      resolvePublicHttpsUrl('https://cdn.example.com/a.jpg', resolvesTo('8.8.8.8', '192.168.1.5'))
    ).rejects.toBeInstanceOf(UnsafeUrlError)
  })
})

describe('isWellFormedPublicHttpsUrl', () => {
  it.each(['https://acme.com/hook', 'https://api.acme.com:443/a?b=1', 'https://8.8.8.8/a'])(
    'accepts %s',
    raw => {
      expect(isWellFormedPublicHttpsUrl(raw)).toBe(true)
    }
  )

  it.each([
    'http://acme.com',
    'ftp://acme.com',
    'https://user:pass@acme.com',
    'https://acme.com:8443',
    'https://localhost/a',
    'https://intranet/a',
    'https://acme.com./a',
    'https://a..b.com/x',
    'https://admin.corp.internal/',
    'https://printer.local/',
    'https://x.localhost/',
    'https://router.lan/',
    'https://nas.home.arpa/',
    'https://acme.test/',
    'https://acme.example/',
    'https://hidden.onion/',
    'https://acme.123/',
    'https://-a.com/',
    'https://a_b.com/',
    'https://127.0.0.1/a',
    'https://10.0.0.5/a',
    'https://[::1]/a',
    'javascript:alert(1)',
    'not a url',
    ''
  ])('refuses %s', raw => {
    expect(isWellFormedPublicHttpsUrl(raw)).toBe(false)
  })
})
