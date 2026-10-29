import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import { isWithinSchedule, weekScheduleSchema } from '@platform/core/domain'

import type { WidgetSite } from './widget-sites.service'

// Whether the store is closed right now, by its business hours, so that the widget can say so. A store
// that set no hours, or hours that cannot be read, is never "away".
@Injectable()
export class WidgetAway {
  constructor(private readonly prisma: PrismaService) {}

  async isAway(site: WidgetSite, at = new Date()): Promise<boolean> {
    const hours = await this.prisma.client.businessHours.findUnique({
      where: { storeId: site.storeId },
      select: { timezone: true, schedule: true }
    })
    if (hours === null) return false
    const schedule = weekScheduleSchema.safeParse(hours.schedule)
    if (!schedule.success) return false
    return !isWithinSchedule(schedule.data, hours.timezone, at)
  }
}
