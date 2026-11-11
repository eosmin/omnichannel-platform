import {
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  type RawBodyRequest,
  Req
} from '@nestjs/common'
import type { Request } from 'express'

import { ApiRoutes } from '@platform/core/api'
import { CarrierWebhookThrottle } from '@platform/core/auth'
import { Public } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { RateLimit } from '@platform/core/http'

import { CarrierWebhookService } from './carrier-webhook.service'

// Only the strings of the headers: the plugin verifies a signature, not a list
function stringHeaders(headers: Request['headers']): Record<string, string> {
  const strings: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') strings[name] = value
  }
  return strings
}

// Public (CLAUDE.md rule 5): the signature of the body, checked with the secret of the connection in the address,
// authenticates it (TDD_17 §4.9). It does nothing else: the service verifies, queues and answers at once, and the worker
// applies the events.
@Public()
@RateLimit(CarrierWebhookThrottle)
@Controller()
export class CarrierWebhookController {
  constructor(private readonly webhooks: CarrierWebhookService) {}

  @Post(ApiRoutes.webhooks.carrier(':connectionId'))
  @HttpCode(HttpStatusCodes.OK)
  async receive(
    @Param('connectionId') connectionId: string,
    @Req() req: RawBodyRequest<Request> & { correlationId?: string },
    @Headers() headers: Request['headers']
  ): Promise<{ received: true }> {
    await this.webhooks.receive(
      connectionId,
      req.rawBody,
      stringHeaders(headers),
      req.body,
      req.correlationId
    )
    return { received: true }
  }
}
