import { createHmac } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'

import {
  COOKIE_CONSENT_HASH_KEY,
  ChoosableCookieCategories,
  CookieConsentLimits
} from '@platform/core/compliance'
import { PrismaService } from '@platform/core/database'

import type { CookieConsentBody } from './compliance.schemas'

export interface CookieConsentView {
  // True when a row was written; false when the newest row of the visitor already said the same
  recorded: boolean
}

export interface CookieConsentContext {
  // The person's account, from a valid token when there is one: never from the body
  userId: string | undefined
  ipAddress: string | undefined
  userAgent: string | undefined
}

// Category by category, not by the text of the JSON: the database keeps `jsonb`, which does not keep the order of the keys
function sameChoice(stored: unknown, chosen: Record<string, boolean>): boolean {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return false
  const row = stored as Record<string, unknown>
  return ChoosableCookieCategories.every(category => row[category] === chosen[category])
}

// A keyed hash of the address: the proof that a choice came from somewhere, without keeping the address (TDD_05 §10.5)
export function hashClientAddress(address: string, key: string): string {
  return createHmac('sha256', key).update(address).digest('hex')
}

// The record of the cookie banner (TDD_05 §10.5), for people who are not customers: platform users and anonymous visitors. It is
// not tenant data (no store): the visitor id is a random id the browser made, and the table keeps the history of the choice, so a
// change is a new row and the newest one rules. Answering the same thing again writes nothing.
@Injectable()
export class CookieConsentService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(COOKIE_CONSENT_HASH_KEY) private readonly hashKey: string
  ) {}

  async record(body: CookieConsentBody, context: CookieConsentContext): Promise<CookieConsentView> {
    const categories = Object.fromEntries(
      ChoosableCookieCategories.map(category => [category, body.categories[category]])
    )
    // The token is not looked up again on a public route: one still valid for an account that was just deleted would break the
    // foreign key, and the choice of that browser is still worth keeping, as an anonymous one
    const account =
      context.userId === undefined
        ? null
        : await this.prisma.client.user.findUnique({
            where: { id: context.userId },
            select: { id: true }
          })
    const userId = account?.id ?? null
    const latest = await this.prisma.client.cookieConsent.findFirst({
      where: { visitorId: body.visitorId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { categories: true, policyVersion: true, userId: true }
    })
    if (
      latest !== null &&
      latest.policyVersion === body.policyVersion &&
      latest.userId === userId &&
      sameChoice(latest.categories, categories)
    ) {
      return { recorded: false }
    }
    await this.prisma.client.cookieConsent.create({
      data: {
        visitorId: body.visitorId,
        userId,
        categories,
        policyVersion: body.policyVersion,
        ipHash:
          context.ipAddress === undefined
            ? null
            : hashClientAddress(context.ipAddress, this.hashKey),
        userAgent: context.userAgent?.slice(0, CookieConsentLimits.USER_AGENT_MAX_LENGTH) ?? null
      }
    })
    return { recorded: true }
  }
}
