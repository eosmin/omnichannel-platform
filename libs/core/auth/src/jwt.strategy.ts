import { Inject, Injectable } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { z } from 'zod'

import type { AuthenticatedUser } from '@platform/core/auth'

import { AUTH_SETTINGS, type AuthSettings } from './auth-settings'

const claimsSchema = z.object({ sub: z.uuid(), sid: z.uuid(), email: z.email() })

// The claims of a token whose signature already verified, as the user they stand for. Shared with
// the Bull Board middleware, which verifies tokens outside the guard.
export function toAuthenticatedUser(payload: unknown): AuthenticatedUser | false {
  const claims = claimsSchema.safeParse(payload)
  if (!claims.success) return false
  return { id: claims.data.sub, sessionFamilyId: claims.data.sid, email: claims.data.email }
}

// Verifies the signature and the expiry of the access token; the claims are then data like any
// other, so they are checked too. Stateless: no database read per request (TDD_01 section 7).
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(@Inject(AUTH_SETTINGS) settings: AuthSettings) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: settings.jwtSecret,
      algorithms: ['HS256'], // Pinned: a token that names another algorithm, or none, is refused
      ignoreExpiration: false
    })
  }

  validate(payload: unknown): AuthenticatedUser | false {
    return toAuthenticatedUser(payload)
  }
}
