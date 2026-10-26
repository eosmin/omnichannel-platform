import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common'
import type { Request } from 'express'

import { ApiRoutes } from '@platform/core/api'
import {
  type AuthenticatedUser,
  InvitationAcceptThrottle,
  ThrottleProfiles
} from '@platform/core/auth'
import { OptionalSession, OptionalUser, Public } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, RateLimit, ZodValidationPipe } from '@platform/core/http'

import {
  type AcceptInvitationBody,
  acceptInvitationSchema,
  invitationTokenSchema
} from './invitations.schemas'
import {
  type AcceptedInvitation,
  InvitationAcceptService,
  type InvitationPreview
} from './invitations.service'

// The two routes of the link in the email. They have no store: the invitation says which one, and
// the token in the path is the credential (the request logs scrub it, see libs/core/logger).
@Controller()
export class InvitationsController {
  constructor(private readonly invitations: InvitationAcceptService) {}

  @Public()
  @RateLimit(ThrottleProfiles.PUBLIC)
  @NoStore()
  @Get(ApiRoutes.invitations.byToken(':token'))
  preview(
    @Param('token', new ZodValidationPipe(invitationTokenSchema)) token: string
  ): Promise<InvitationPreview> {
    return this.invitations.preview(token)
  }

  // Public, with a session if the person has one: a person with an account has to be logged in as
  // the invited address, and one without creates theirs here
  @OptionalSession()
  @RateLimit(InvitationAcceptThrottle)
  @NoStore()
  @Post(ApiRoutes.invitations.accept(':token'))
  @HttpCode(HttpStatusCodes.OK)
  accept(
    @Param('token', new ZodValidationPipe(invitationTokenSchema)) token: string,
    @Body(new ZodValidationPipe(acceptInvitationSchema)) body: AcceptInvitationBody,
    @OptionalUser() session: AuthenticatedUser | undefined,
    @Req() req: Request
  ): Promise<AcceptedInvitation> {
    return this.invitations.accept(token, body, session, {
      userAgent: req.get('user-agent'),
      ipAddress: req.ip
    })
  }
}
