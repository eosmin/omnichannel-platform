import { createBrowserSession } from './browser-session'
import { SessionRoutes } from './session-routes'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const session = (accessToken: string): Response => json(200, { accessToken, expiresIn: 900 })
const unauthorized = (): Response =>
  json(401, {
    error: { code: 'AUTH_UNAUTHORIZED', message: 'x', metadata: {} },
    correlationId: 'c'
  })

describe('createBrowserSession', () => {
  it('keeps the access token in memory after a refresh', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(session('a1'))
    const browser = createBrowserSession({ fetchImpl, locks: undefined })
    expect(browser.getAccessToken()).toBeNull()
    await expect(browser.refresh()).resolves.toBe('a1')
    expect(browser.getAccessToken()).toBe('a1')
    expect(fetchImpl).toHaveBeenCalledWith(
      SessionRoutes.refresh,
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' })
    )
  })

  it('shares one request among callers that refresh at the same time', async () => {
    const fetchImpl = jest.fn(() => Promise.resolve(session('a1')))
    const browser = createBrowserSession({ fetchImpl, locks: undefined })
    await Promise.all([browser.refresh(), browser.refresh(), browser.refresh()])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await browser.refresh()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('holds the cross-tab lock while it rotates the cookie', async () => {
    const request = jest.fn((_name: string, work: () => Promise<string>) => work())
    const fetchImpl = jest.fn().mockResolvedValue(session('a1'))
    const browser = createBrowserSession({ fetchImpl, locks: { request } })
    await browser.refresh()
    expect(request).toHaveBeenCalledWith('platform-refresh', expect.any(Function))
  })

  it('does not report a session lost when the page never had one', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(unauthorized())
    const browser = createBrowserSession({ fetchImpl, locks: undefined })
    const lost = jest.fn()
    browser.onSessionLost(lost)
    await expect(browser.refresh()).rejects.toMatchObject({ status: 401 })
    expect(lost).not.toHaveBeenCalled()
  })

  it('forgets the token and tells the listeners when the session is gone', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(session('a1'))
      .mockResolvedValueOnce(unauthorized())
    const browser = createBrowserSession({ fetchImpl, locks: undefined })
    const lost = jest.fn()
    browser.onSessionLost(lost)
    await browser.refresh()
    await expect(browser.refresh()).rejects.toMatchObject({ status: 401 })
    expect(browser.getAccessToken()).toBeNull()
    expect(lost).toHaveBeenCalledTimes(1)
  })

  it('keeps the session when the refresh fails for another reason', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(session('a1'))
      .mockResolvedValueOnce(new Response('x', { status: 500 }))
    const browser = createBrowserSession({ fetchImpl, locks: undefined })
    const lost = jest.fn()
    browser.onSessionLost(lost)
    await browser.refresh()
    await expect(browser.refresh()).rejects.toMatchObject({ status: 500 })
    expect(browser.getAccessToken()).toBe('a1')
    expect(lost).not.toHaveBeenCalled()
  })

  it('stops calling a listener that unsubscribed', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(unauthorized())
    const browser = createBrowserSession({ fetchImpl, locks: undefined })
    const lost = jest.fn()
    browser.onSessionLost(lost)()
    await browser.refresh().catch(() => undefined)
    expect(lost).not.toHaveBeenCalled()
  })

  it('consumes a magic-link token and keeps the access token', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(session('a2'))
    const browser = createBrowserSession({ fetchImpl, locks: undefined })
    await browser.consume('tok')
    expect(browser.getAccessToken()).toBe('a2')
    expect(fetchImpl).toHaveBeenCalledWith(
      SessionRoutes.consume,
      expect.objectContaining({ body: '{"token":"tok"}' })
    )
  })

  it('throws the error of a refused token and keeps no session', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(unauthorized())
    const browser = createBrowserSession({ fetchImpl, locks: undefined })
    await expect(browser.consume('bad')).rejects.toMatchObject({ code: 'AUTH_UNAUTHORIZED' })
    expect(browser.getAccessToken()).toBeNull()
  })

  it('keeps the token when the logout fails, since the person is still signed in', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(session('a1'))
      .mockResolvedValueOnce(new Response('x', { status: 500 }))
    const browser = createBrowserSession({ fetchImpl, locks: undefined })
    await browser.refresh()
    await expect(browser.logout()).rejects.toMatchObject({ status: 500 })
    expect(browser.getAccessToken()).toBe('a1')
  })

  it('keeps the token when the logout cannot reach the server', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(session('a1'))
      .mockRejectedValueOnce(new TypeError('network'))
    const browser = createBrowserSession({ fetchImpl, locks: undefined })
    await browser.refresh()
    await expect(browser.logout()).rejects.toMatchObject({ status: 0 })
    expect(browser.getAccessToken()).toBe('a1')
  })

  it('sends the access token with an invitation and keeps the session of a new account', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(session('a1'))
      .mockResolvedValueOnce(
        json(200, {
          store: { id: 's', name: 'S' },
          role: 'Agent',
          accessToken: 'a9',
          expiresIn: 900
        })
      )
    const browser = createBrowserSession({ fetchImpl, locks: undefined })
    await browser.refresh()
    const accepted = await browser.acceptInvitation('tok', 'Ana')
    expect(accepted.store.id).toBe('s')
    expect(browser.getAccessToken()).toBe('a9')
    expect(fetchImpl).toHaveBeenLastCalledWith(
      SessionRoutes.accept,
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer a1' }) as unknown,
        body: '{"token":"tok","name":"Ana"}'
      })
    )
  })

  it('leaves the token alone when an accepted invitation brings no session', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(session('a1'))
      .mockResolvedValueOnce(json(200, { store: { id: 's', name: 'S' }, role: 'Agent' }))
    const browser = createBrowserSession({ fetchImpl, locks: undefined })
    await browser.refresh()
    await browser.acceptInvitation('tok')
    expect(browser.getAccessToken()).toBe('a1')
  })

  it('throws the refusal of an invitation as it came', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(unauthorized())
    const browser = createBrowserSession({ fetchImpl, locks: undefined })
    await expect(browser.acceptInvitation('tok')).rejects.toMatchObject({ status: 401 })
  })

  it('forgets the token after a logout that went through', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(session('a1'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const browser = createBrowserSession({ fetchImpl, locks: undefined })
    await browser.refresh()
    await browser.logout()
    expect(browser.getAccessToken()).toBeNull()
  })

  it('takes a new access token and tries an invitation again when the old one expired', async () => {
    const expired = json(401, {
      error: { code: 'AUTH_TOKEN_EXPIRED', message: 'x', metadata: {} },
      correlationId: 'c'
    })
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(session('a1'))
      .mockResolvedValueOnce(expired)
      .mockResolvedValueOnce(session('a2'))
      .mockResolvedValueOnce(json(200, { store: { id: 's', name: 'S' }, role: 'Agent' }))
    const browser = createBrowserSession({ fetchImpl, locks: undefined })
    await browser.refresh()
    await browser.acceptInvitation('tok')
    expect(fetchImpl).toHaveBeenLastCalledWith(
      SessionRoutes.accept,
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer a2' }) as unknown
      })
    )
  })
})
