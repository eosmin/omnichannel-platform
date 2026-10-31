import { TypingTiming } from '@platform/core/realtime'

export interface TypingAnnouncerOptions {
  // Returns false when nothing went out (no connection): the start is then tried again at the next key
  sendStart: () => boolean
  sendStop: () => void
  now?: () => number
}

// Tells the others that this agent is typing: a start at most once in AGENT_START_GAP_MS while keys
// keep coming, and a stop when the agent goes idle, empties the box, sends, or leaves.
export class TypingAnnouncer {
  private isActive = false
  private lastStartAt = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private readonly now: () => number

  constructor(private readonly options: TypingAnnouncerOptions) {
    this.now = options.now ?? Date.now
  }

  type(): void {
    const at = this.now()
    if (!this.isActive || at - this.lastStartAt >= TypingTiming.AGENT_START_GAP_MS) {
      if (this.options.sendStart()) {
        this.lastStartAt = at
        this.isActive = true
      }
    }
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.stop(), TypingTiming.AGENT_IDLE_STOP_MS)
  }

  stop(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    if (!this.isActive) return
    this.isActive = false
    this.options.sendStop()
  }
}
