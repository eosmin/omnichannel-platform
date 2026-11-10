import { WidgetLimits } from '@platform/core/domain'

// Decides which typing signals of the visitors are worth a look at the database. Two limits, both held
// in this process: a visitor (all their tabs together) may signal once in a gap, and a site may take so
// many signals a minute whoever they come from, so that many visitors cannot add up to a flood.
export class WidgetTypingThrottle {
  // Insertion order is time order (a take deletes before it sets), so the old ones are at the front
  private readonly lastByVisitor = new Map<string, number>()
  private readonly windows = new Map<string, { startedAt: number; count: number }>()

  take(siteKey: string, visitorId: string, now = Date.now()): boolean {
    const visitor = `${siteKey}:${visitorId}`
    this.forgetOldVisitors(now)
    const last = this.lastByVisitor.get(visitor)
    if (last !== undefined && now - last < WidgetLimits.CUSTOMER_TYPING_GAP_MS) return false
    const window = this.windowOf(siteKey, now)
    if (window.count >= WidgetLimits.CUSTOMER_TYPING_SITE_PER_MINUTE) return false
    window.count += 1
    this.lastByVisitor.delete(visitor)
    this.lastByVisitor.set(visitor, now)
    return true
  }

  private windowOf(siteKey: string, now: number): { startedAt: number; count: number } {
    const current = this.windows.get(siteKey)
    if (
      current !== undefined &&
      now - current.startedAt < WidgetLimits.CUSTOMER_TYPING_SITE_WINDOW_MS
    )
      return current
    // A site that stopped signalling leaves nothing behind once its minute is over
    for (const [key, window] of this.windows) {
      if (now - window.startedAt < WidgetLimits.CUSTOMER_TYPING_SITE_WINDOW_MS) break
      this.windows.delete(key)
    }
    const fresh = { startedAt: now, count: 0 }
    this.windows.delete(siteKey)
    this.windows.set(siteKey, fresh)
    return fresh
  }

  private forgetOldVisitors(now: number): void {
    for (const [visitor, at] of this.lastByVisitor) {
      if (now - at < WidgetLimits.CUSTOMER_TYPING_GAP_MS) break
      this.lastByVisitor.delete(visitor)
    }
  }
}
