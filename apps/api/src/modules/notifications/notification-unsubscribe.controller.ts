import { Body, Controller, HttpCode, Post, Query } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { UnsubscribeThrottle } from '@platform/core/auth'
import { Public } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, RateLimit } from '@platform/core/http'
import { UNSUBSCRIBE_TOKEN_PARAM } from '@platform/core/notifications'

import { NoTenantTransaction } from '../tenancy'

import { NotificationUnsubscribeService } from './notification-unsubscribe.service'
import { unsubscribeBodySchema, unsubscribeTokenSchema } from './notifications.schemas'

// The one-click unsubscribe of the notification emails (Step 7.3, B6b-3b2b). PUBLIC on purpose (owner decision of 2026-11-23, recorded in IMPLEMENTATION_PLAN.md;
// the rule-5 list of CLAUDE.md is the owner's to edit): the person has no session when they open the link of an email, and the signed token is the credential. There is NO GET: a
// GET that changed state would be fired by every mail scanner and antivirus that opens the links of a message. The page of the web app
// (`AppPaths.unsubscribe`) asks first and then POSTs here with the token in the body; a mail client that honors `List-Unsubscribe-Post`
// (RFC 8058) POSTs `List-Unsubscribe=One-Click` to the URL of the header, whose query carries the token.
//
// It answers 204 for every token it reads or not (a token that is altered, of another key, of a person who is gone, or none): nothing
// here says whether a person exists. (A body the parser itself refuses, malformed JSON or too large, is a 400 or 413 before this handler, whatever the token.) The token is read here without a validation pipe on purpose, for the same reason: a pipe would answer 400
// for some shapes and 204 for others.
@Public()
@Controller()
export class NotificationUnsubscribeController {
  constructor(private readonly unsubscribe: NotificationUnsubscribeService) {}

  @NoTenantTransaction(
    'public route: it opens the context of the one person the signed token names (JobContext.forUser) and writes nothing else'
  )
  @RateLimit(UnsubscribeThrottle)
  @NoStore()
  @Post(ApiRoutes.notifications.unsubscribe)
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async handle(
    @Body() body: unknown,
    @Query(UNSUBSCRIBE_TOKEN_PARAM) query: unknown
  ): Promise<void> {
    const fromBody = unsubscribeBodySchema.safeParse(body)
    const fromQuery = unsubscribeTokenSchema.safeParse(query)
    const token = fromBody.success
      ? fromBody.data.token
      : fromQuery.success
        ? fromQuery.data
        : undefined
    await this.unsubscribe.unsubscribe(token)
  }
}
