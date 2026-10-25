import { randomUUID } from 'node:crypto'

import {
  type ArgumentsHost,
  Catch,
  Controller,
  type ExceptionFilter,
  Get,
  type INestApplication
} from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import type { Response } from 'express'

import type { AuthenticatedUser } from '@platform/core/auth'
import { PlatformException } from '@platform/core/errors'

import { AccessTokenModule } from './access-token.module'
import { type AuthSettings } from './auth-settings'
import { CurrentUser } from './current-user.decorator'
import { Public } from './public.decorator'

const settings: AuthSettings = {
  jwtSecret: 'a-secret-of-at-least-thirty-two-characters!',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 604_800,
  frontendUrl: 'http://localhost:3000'
}

// The error contract is the job of GlobalExceptionFilter (libs/core/http); this keeps the code
@Catch(PlatformException)
class CodeFilter implements ExceptionFilter {
  catch(exception: PlatformException, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(exception.statusCode)
      .json({ code: exception.code })
  }
}

@Controller()
class ProbeController {
  @Get('private')
  whoAmI(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user
  }

  @Public()
  @Get('open')
  open(): { open: true } {
    return { open: true }
  }

  // A route that reads the user but was marked public by mistake: nobody has put a user there
  @Public()
  @Get('open-with-user')
  openWithUser(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user
  }
}

const claims = { sub: randomUUID(), sid: randomUUID(), email: 'owner@example.com' }

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

describe('the access tokens', () => {
  let app: INestApplication
  let baseUrl: string
  let jwt: JwtService

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AccessTokenModule.forRoot(settings)],
      controllers: [ProbeController],
      providers: [{ provide: APP_FILTER, useClass: CodeFilter }]
    }).compile()
    app = module.createNestApplication()
    await app.listen(0)
    baseUrl = await app.getUrl()
    jwt = app.get(JwtService)
  })

  afterAll(() => app.close())

  async function call(
    path: string,
    authorization?: string
  ): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: authorization === undefined ? {} : { authorization }
    })
    return { status: response.status, body: await response.json() }
  }

  it('lets a valid access token through and exposes its user', async () => {
    const token = jwt.sign(claims)

    const result = await call('/private', `Bearer ${token}`)

    expect(result).toEqual({
      status: 200,
      body: { id: claims.sub, sessionFamilyId: claims.sid, email: claims.email }
    })
  })

  it('serves a @Public route without a token', async () => {
    expect(await call('/open')).toEqual({ status: 200, body: { open: true } })
  })

  it('refuses to hand over a user on a public route, instead of answering with nothing', async () => {
    expect(await call('/open-with-user')).toEqual({
      status: 401,
      body: { code: 'AUTH_UNAUTHORIZED' }
    })
  })

  it('refuses a request without a token, telling that none came', async () => {
    expect(await call('/private')).toEqual({ status: 401, body: { code: 'AUTH_UNAUTHORIZED' } })
    expect(await call('/private', 'Basic abc')).toEqual({
      status: 401,
      body: { code: 'AUTH_UNAUTHORIZED' }
    })
  })

  it('refuses an expired token with its own code, so the client knows to refresh', async () => {
    const expired = jwt.sign(claims, { expiresIn: -10 })

    expect(await call('/private', `Bearer ${expired}`)).toEqual({
      status: 401,
      body: { code: 'AUTH_TOKEN_EXPIRED' }
    })
  })

  it.each([
    [
      'one signed with another secret',
      () => new JwtService({ secret: 'x'.repeat(40) }).sign(claims)
    ],
    [
      'one signed with the right secret but another algorithm',
      () => jwt.sign(claims, { algorithm: 'HS512' })
    ],
    [
      'an unsigned one (alg none)',
      () => `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(claims)}.`
    ],
    ['one whose signature was altered', () => `${jwt.sign(claims).slice(0, -3)}abc`],
    ['one whose user is not a UUID', () => jwt.sign({ ...claims, sub: 'owner' })],
    ['one without an email', () => jwt.sign({ sub: claims.sub, sid: claims.sid })],
    ['garbage', () => 'not-a-jwt']
  ])('refuses %s', async (_name, makeToken) => {
    expect(await call('/private', `Bearer ${makeToken()}`)).toEqual({
      status: 401,
      body: { code: 'AUTH_TOKEN_INVALID' }
    })
  })

  it('makes JwtService verify with HS256 only, wherever the application code calls it', () => {
    const hs512 = jwt.sign(claims, { algorithm: 'HS512' })

    expect(() => {
      jwt.verify(hs512)
    }).toThrow()
    expect(() => {
      jwt.verify(jwt.sign(claims))
    }).not.toThrow()
  })

  it('does not take the token from the query string', async () => {
    const token = jwt.sign(claims)

    expect((await call(`/private?access_token=${token}`)).status).toBe(401)
  })
})
