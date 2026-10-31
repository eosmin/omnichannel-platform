import { TypingTiming } from '@platform/core/realtime'

export interface TypingSnapshot {
  isCustomerTyping: boolean
  // Names of the teammates who are typing, in the order they started
  teammates: string[]
}

export const NOBODY_TYPING: TypingSnapshot = { isCustomerTyping: false, teammates: [] }

// Who is typing in the open conversation. The customer has no stop signal, so a signal lapses after
// CUSTOMER_LAPSE_MS; a teammate's start with no stop lapses after TEAMMATE_LAPSE_MS.
export class TypingTracker {
  private customerTimer: ReturnType<typeof setTimeout> | undefined
  private readonly teammates = new Map<
    string,
    { name: string; timer: ReturnType<typeof setTimeout> }
  >()

  constructor(private readonly onChange: (snapshot: TypingSnapshot) => void) {}

  customerTyping(): void {
    clearTimeout(this.customerTimer)
    this.customerTimer = setTimeout(() => this.clearCustomer(), TypingTiming.CUSTOMER_LAPSE_MS)
    this.publish(true)
  }

  // What the customer sent ends the typing that announced it
  clearCustomer(): void {
    if (this.customerTimer === undefined) return
    clearTimeout(this.customerTimer)
    this.customerTimer = undefined
    this.publish(false)
  }

  teammateStart(userId: string, name: string): void {
    const current = this.teammates.get(userId)
    if (current !== undefined) clearTimeout(current.timer)
    const timer = setTimeout(() => this.teammateStop(userId), TypingTiming.TEAMMATE_LAPSE_MS)
    this.teammates.set(userId, { name, timer })
    this.publish(this.customerTimer !== undefined)
  }

  teammateStop(userId: string): void {
    const current = this.teammates.get(userId)
    if (current === undefined) return
    clearTimeout(current.timer)
    this.teammates.delete(userId)
    this.publish(this.customerTimer !== undefined)
  }

  dispose(): void {
    clearTimeout(this.customerTimer)
    this.teammates.forEach(({ timer }) => clearTimeout(timer))
    this.teammates.clear()
  }

  private publish(isCustomerTyping: boolean): void {
    this.onChange({
      isCustomerTyping,
      teammates: [...this.teammates.values()].map(({ name }) => name)
    })
  }
}
