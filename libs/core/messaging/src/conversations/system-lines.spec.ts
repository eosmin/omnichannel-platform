import { ConversationStatus, SystemMessageEvents } from '@platform/core/domain'

import { systemEventFor, systemLineMetadataSchema } from './system-lines'

const { OPEN, PENDING, RESOLVED, ARCHIVED, SNOOZED, SPAM } = ConversationStatus

describe('systemEventFor', () => {
  it.each([
    [OPEN, RESOLVED, SystemMessageEvents.RESOLVED],
    [PENDING, RESOLVED, SystemMessageEvents.RESOLVED],
    [RESOLVED, ARCHIVED, SystemMessageEvents.ARCHIVED],
    [OPEN, SPAM, SystemMessageEvents.MARKED_SPAM],
    [OPEN, SNOOZED, SystemMessageEvents.SNOOZED],
    [SNOOZED, OPEN, SystemMessageEvents.WOKEN],
    [SPAM, OPEN, SystemMessageEvents.UNMARKED_SPAM],
    [RESOLVED, OPEN, SystemMessageEvents.REOPENED],
    [ARCHIVED, OPEN, SystemMessageEvents.REOPENED]
  ])('%s to %s is %s', (from, to, event) => {
    expect(systemEventFor(from, to)).toBe(event)
  })

  it('says that a resolution was undone only when the person asked to undo it', () => {
    expect(systemEventFor(RESOLVED, OPEN, true)).toBe(SystemMessageEvents.RESOLVE_UNDONE)
    expect(systemEventFor(RESOLVED, OPEN, false)).toBe(SystemMessageEvents.REOPENED)
    expect(systemEventFor(ARCHIVED, OPEN, true)).toBe(SystemMessageEvents.REOPENED)
  })

  it.each([
    [OPEN, PENDING],
    [PENDING, OPEN],
    [RESOLVED, PENDING]
  ])('%s to %s is not worth a line', (from, to) => {
    expect(systemEventFor(from, to)).toBeNull()
  })
})

describe('systemLineMetadataSchema', () => {
  it('refuses a line with an unknown event', () => {
    const line = {
      event: 'exploded',
      actor: { type: 'system', id: null },
      causedBy: null,
      from: null,
      to: null,
      reason: null,
      snoozedUntil: null,
      assignedTo: null,
      previousAssignee: null
    }
    expect(systemLineMetadataSchema.safeParse(line).success).toBe(false)
  })
})
