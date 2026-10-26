import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { unauthorized } from '@platform/core/errors'

export interface AccountProfile {
  id: string
  email: string
  name: string
  emailVerified: boolean
  locale: string
  timezone: string | null
  density: string
}

@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  // The access token outlives the account for up to its lifetime, so the user may be gone
  async profile(userId: string): Promise<AccountProfile> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        emailVerified: true,
        locale: true,
        timezone: true,
        density: true
      }
    })
    if (user === null) {
      throw unauthorized('account no longer exists')
    }
    return user
  }
}
