import { Injectable } from '@nestjs/common'

import {
  signVisitorToken,
  verifyVisitorToken,
  type VisitorClaims,
  type VisitorIdentity,
  WidgetConfig
} from '@platform/channels/web-widget'
import { WidgetLimits } from '@platform/core/domain'

// The tokens of the visitors: given at the bootstrap, asked for by every other door of the widget
@Injectable()
export class WidgetTokens {
  constructor(private readonly config: WidgetConfig) {}

  issue(identity: VisitorIdentity): { token: string; expiresInSeconds: number } {
    return {
      token: signVisitorToken(this.config.tokenKey, identity),
      expiresInSeconds: WidgetLimits.TOKEN_TTL_SECONDS
    }
  }

  verify(token: unknown): VisitorClaims | null {
    return verifyVisitorToken(this.config.tokenKey, token)
  }
}
