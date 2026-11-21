import { AppPaths } from '@platform/api-client'

import { expect, test } from '../support/test'

// The headers a real browser gets from the running web server (the unit specs pin the builders; this one proves that
// next.config.ts and proxy.ts really put them on a page, and that the nonce changes per request)
test.describe('security headers of the web app', () => {
  test('a page carries the static headers and a policy that forbids framing', async ({
    request
  }) => {
    const response = await request.get(AppPaths.login)
    const headers = response.headers()

    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['cross-origin-opener-policy']).toBe('same-origin-allow-popups')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['strict-transport-security']).toContain('max-age=31536000')
    expect(headers['x-powered-by']).toBeUndefined()
    const policy = headers['content-security-policy'] ?? ''
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("frame-src 'none'")
  })

  test('the nonce of the policy is new on every request', async ({ request }) => {
    const nonceOf = async (): Promise<string | undefined> =>
      /'nonce-([^']+)'/.exec(
        (await request.get(AppPaths.login)).headers()['content-security-policy'] ?? ''
      )?.[1]

    const first = await nonceOf()
    const second = await nonceOf()

    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first).not.toBe(second)
  })
})
