import { Controller, Get, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { API_PREFIX } from '@platform/core/api'
import { LoggerModule } from '@platform/core/logger'
import { MetricsModule } from '@platform/core/metrics-module'

import { configureHttpApp } from './configure-http-app'
import { HttpErrorsModule } from './http-errors.module'

@Controller()
class PingController {
  @Get('ping')
  ping(): { ok: true } {
    return { ok: true }
  }

  @Get('boom')
  boom(): never {
    throw new Error('boom')
  }
}

describe('security headers of the http apps', () => {
  let app: INestApplication
  let url: string

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ level: 'fatal', pretty: false }),
        MetricsModule,
        HttpErrorsModule
      ],
      controllers: [PingController]
    }).compile()
    app = module.createNestApplication({ bufferLogs: true })
    await configureHttpApp(app)
    await app.listen(0)
    url = await app.getUrl()
  })
  afterAll(() => app.close())

  const headersOf = async (path: string): Promise<Headers> => (await fetch(`${url}${path}`)).headers

  it('forbids every source and every frame, and keeps the referrer to itself', async () => {
    const headers = await headersOf(`${API_PREFIX}/ping`)

    expect(headers.get('content-security-policy')).toBe("default-src 'none';frame-ancestors 'none'")
    expect(headers.get('referrer-policy')).toBe('no-referrer')
    expect(headers.get('cross-origin-resource-policy')).toBe('same-site')
    expect(headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('tells the browser to use https for a year, subdomains and preload included', async () => {
    const headers = await headersOf(`${API_PREFIX}/ping`)

    expect(headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains; preload'
    )
  })

  it('does not say which framework answers', async () => {
    expect((await headersOf(`${API_PREFIX}/ping`)).get('x-powered-by')).toBeNull()
  })

  it.each([
    ['an unknown route', `${API_PREFIX}/nothing-here`],
    ['a route outside the prefix', '/nothing-here'],
    ['a route that fails', `${API_PREFIX}/boom`]
  ])('also sets them on %s', async (_name, path) => {
    const headers = await headersOf(path)

    expect(headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(headers.get('x-content-type-options')).toBe('nosniff')
  })
})
