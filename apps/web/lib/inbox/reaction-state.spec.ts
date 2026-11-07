import { DeliveryStatus } from '@platform/core/domain'

import { groupStateOf, reactionStateOf } from './reaction-state'

const reaction = (deliveryStatus: string | null) => ({ deliveryStatus })

describe('reactionStateOf', () => {
  it('is waiting while the channel has not taken it, and that is not a problem', () => {
    expect(reactionStateOf(reaction(DeliveryStatus.QUEUED))).toBe('pending')
  })

  it('is failed only when the channel refused it', () => {
    expect(reactionStateOf(reaction(DeliveryStatus.FAILED))).toBe('failed')
  })

  it('says nothing for a reaction that was taken, or one of the customer', () => {
    for (const status of [
      DeliveryStatus.SENT,
      DeliveryStatus.DELIVERED,
      DeliveryStatus.READ,
      null
    ]) {
      expect(reactionStateOf(reaction(status))).toBeNull()
    }
  })
})

describe('groupStateOf', () => {
  it('shows no warning for a chip whose reactions are only waiting (the flash on a normal network)', () => {
    expect(groupStateOf([reaction(DeliveryStatus.QUEUED)])).toBe('pending')
    expect(groupStateOf([reaction(DeliveryStatus.QUEUED), reaction(DeliveryStatus.SENT)])).toBe(
      'pending'
    )
  })

  it('shows the warning only when one failed, which wins over waiting', () => {
    expect(groupStateOf([reaction(DeliveryStatus.SENT), reaction(DeliveryStatus.FAILED)])).toBe(
      'failed'
    )
    expect(groupStateOf([reaction(DeliveryStatus.QUEUED), reaction(DeliveryStatus.FAILED)])).toBe(
      'failed'
    )
  })

  it('is quiet when everything was taken', () => {
    expect(groupStateOf([reaction(DeliveryStatus.SENT), reaction(null)])).toBeNull()
  })
})
