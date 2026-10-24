import { randomUUID } from 'node:crypto'

import { Controller, Get, type INestApplication, Req } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { Request } from 'express'

import type { AuthenticatedRequest } from './authenticated-request'
import { CORRELATION_ID_HEADER, correlationIdMiddleware } from './correlation-id.middleware'

@Controller()
class EchoController {
  @Get('echo')
  echo(@Req() request: Request): { correlationId: string } {
    return { correlationId: (request as AuthenticatedRequest).correlationId }
  }
}

describe('correlationIdMiddleware', () => {
  let app: INestApplication
  let baseUrl: string

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [EchoController] }).compile()
    app = module.createNestApplication()
    app.use(correlationIdMiddleware)
    await app.listen(0)
    baseUrl = await app.getUrl()
  })

  afterAll(() => app.close())

  it('keeps a well-formed UUID from the client and echoes it', async () => {
    const id = randomUUID()
    const response = await fetch(`${baseUrl}/echo`, { headers: { [CORRELATION_ID_HEADER]: id } })
    expect(response.headers.get(CORRELATION_ID_HEADER)).toBe(id)
    expect(await response.json()).toEqual({ correlationId: id })
  })

  it('replaces anything that is not a UUID', async () => {
    for (const value of ['not-a-uuid', '<script>alert(1)</script>', '12345']) {
      const response = await fetch(`${baseUrl}/echo`, {
        headers: { [CORRELATION_ID_HEADER]: value }
      })
      const sent = response.headers.get(CORRELATION_ID_HEADER)
      expect(sent).not.toBe(value)
      expect(sent).toMatch(/^[0-9a-f-]{36}$/)
    }
  })

  it('makes one when the client sends none', async () => {
    const response = await fetch(`${baseUrl}/echo`)
    expect(response.headers.get(CORRELATION_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/)
  })
})
