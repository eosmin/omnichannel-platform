import {
  hasGivenUpWaiting,
  isWaitingForVariants,
  linksIntervalMs,
  VariantWait
} from './variant-wait'

describe('linksIntervalMs', () => {
  const STEADY = 600_000

  it('reads again soon the links of a picture whose variants are awaited', () => {
    expect(linksIntervalMs(false, 1, STEADY)).toBe(VariantWait.POLL_MS)
    expect(linksIntervalMs(false, VariantWait.MAX_POLLS, STEADY)).toBe(VariantWait.POLL_MS)
  })

  it('goes back to the life of the links after the reads it is allowed', () => {
    expect(linksIntervalMs(false, VariantWait.MAX_POLLS + 1, STEADY)).toBe(STEADY)
    // A query that read the links many times through events is past it however few polls ran
    expect(linksIntervalMs(false, 50, STEADY)).toBe(STEADY)
  })

  it('leaves a processed file, and one not read yet, on the life of the links', () => {
    expect(linksIntervalMs(true, 1, STEADY)).toBe(STEADY)
    expect(linksIntervalMs(true, 0, STEADY)).toBe(STEADY)
    expect(linksIntervalMs(undefined, 0, STEADY)).toBe(STEADY)
    expect(linksIntervalMs(undefined, 50, STEADY)).toBe(STEADY)
  })
})

describe('hasGivenUpWaiting', () => {
  it('gives up after the first read plus the polls it allows, and not before', () => {
    expect(hasGivenUpWaiting(0)).toBe(false)
    expect(hasGivenUpWaiting(VariantWait.MAX_POLLS)).toBe(false)
    expect(hasGivenUpWaiting(VariantWait.MAX_POLLS + 1)).toBe(true)
  })

  it('is the same number at which the poll stops, so no read is left unasked', () => {
    // The last read before the poll stops is the one that makes the picture a download
    expect(linksIntervalMs(false, VariantWait.MAX_POLLS, 1)).toBe(VariantWait.POLL_MS)
    expect(linksIntervalMs(false, VariantWait.MAX_POLLS + 1, 1)).toBe(1)
    expect(hasGivenUpWaiting(VariantWait.MAX_POLLS + 1)).toBe(true)
  })
})

describe('isWaitingForVariants', () => {
  it('waits while the worker makes the variants of a picture', () => {
    expect(isWaitingForVariants({ processed: false, hasPreview: false, givenUp: false })).toBe(true)
  })

  it('stops waiting once the links were read as often as the wait allows, so a lost job is a download', () => {
    expect(isWaitingForVariants({ processed: false, hasPreview: false, givenUp: true })).toBe(false)
  })

  it('does not wait for a picture that is processed: with no variant the decoder refused it', () => {
    expect(isWaitingForVariants({ processed: true, hasPreview: false, givenUp: false })).toBe(false)
  })

  it('does not wait when there is already something to draw', () => {
    expect(isWaitingForVariants({ processed: false, hasPreview: true, givenUp: false })).toBe(false)
  })
})
