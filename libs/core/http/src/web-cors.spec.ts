import { Controller, Get, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { API_PREFIX } from '@platform/core/api'
import { LoggerModule } from '@platform/core/logger'
import { MetricsModule } from '@platform/core/metrics-module'

import { configureHttpApp } from './configure-http-app'
import { HttpErrorsModule } from './http-errors.module'

const WEB_ORIGIN = 'https://app.example.com'

@Controller()
class PingController {
  @Get('ping')
  ping(): { ok: true } {
    return { ok: true }
  }
}

describe('CORS of the web app', () => {
  let app: INestApplication
  let url: string

  async function start(webOrigin?: string): Promise<void> {
    const module = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ level: 'fatal', pretty: false }),
        MetricsModule,
        HttpErrorsModule
      ],
      controllers: [PingController]
    }).compile()
    app = module.createNestApplication({ bufferLogs: true })
    await configureHttpApp(app, { webOrigin })
    await app.listen(0)
    url = `${await app.getUrl()}${API_PREFIX}/ping`
  }

  afterEach(async () => {
    await app.close()
  })

  it('answers the preflight of its own origin with the headers the client sends', async () => {
    await start(WEB_ORIGIN)
    const response = await fetch(url, { method: 'OPTIONS', headers: { origin: WEB_ORIGIN } })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN)
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'authorization, content-type, x-store-id'
    )
    expect(response.headers.get('access-control-allow-methods')).toBe(
      'GET, POST, PUT, PATCH, DELETE'
    )
    expect(response.headers.get('access-control-allow-credentials')).toBeNull()
    expect(response.headers.get('vary')).toContain('Origin')
  })

  it('lets the web app read the answer and the headers it needs', async () => {
    await start(WEB_ORIGIN)
    const response = await fetch(url, { headers: { origin: WEB_ORIGIN } })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN)
    expect(response.headers.get('access-control-expose-headers')).toBe(
      'x-correlation-id, retry-after'
    )
  })

  it('grants nothing to any other origin, and leaves its preflight to the route', async () => {
    await start(WEB_ORIGIN)
    const get = await fetch(url, { headers: { origin: 'https://evil.example.com' } })
    expect(get.headers.get('access-control-allow-origin')).toBeNull()
    expect(get.headers.get('vary')).toContain('Origin')
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com' }
    })
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull()
    expect(preflight.status).toBe(404)
  })

  it('grants nothing to a request without origin, or when no web origin is set', async () => {
    await start()
    const response = await fetch(url, { headers: { origin: WEB_ORIGIN } })
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})
