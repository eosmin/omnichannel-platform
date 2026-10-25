import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'

// Users whose address the provider reported as dead: the magic link skips them (MagicLinkService).
// An address that belongs to no user (a customer's) changes nothing here; the suppression list for
// those is a later, global table (MVP_TRIM_CHECKLIST.md, "Email build details (Step 1.0)").
@Injectable()
export class EmailValidityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(EmailValidityService.name)
  }

  // Compares lower-cased addresses exactly (not ILIKE, where "%" and "_" are wildcards), as the
  // magic link does, because the seed stores the address as it was written
  async markInvalid(addresses: readonly string[]): Promise<number> {
    const lowered = addresses.map(address => address.trim().toLowerCase())
    const updated = await this.prisma.client.$executeRaw`
      UPDATE users SET email_valid = false, updated_at = now()
      WHERE email_valid AND lower(email) = ANY(${lowered}::text[])`
    if (updated > 0)
      this.logger.warn({ users: updated }, 'user email marked invalid by the provider')
    return updated
  }
}
