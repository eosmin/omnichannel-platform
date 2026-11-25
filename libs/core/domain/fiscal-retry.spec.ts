import {
  FiscalContingencyLimits,
  fiscalJobOptions,
  FiscalLimits,
  fiscalReleasedJobOptions,
  fiscalReportJobOptions,
  fiscalSubmitMaxAttempts
} from './fiscal-constants'

describe('how often the authority is asked again (the rules of the authority)', () => {
  it('never waits more than the interval between two attempts of a submission', () => {
    const { backoff, attempts } = fiscalJobOptions()
    expect(backoff.type).toBe('exponential')
    // The longest wait of the queue is the one before the last attempt: delay * 2^(attempts - 2)
    const longest = backoff.delay * 2 ** (attempts - 2)
    expect(longest).toBeLessThanOrEqual(FiscalContingencyLimits.RETRY_INTERVAL_MS)
  })

  it('asks for the report at a fixed interval of 15 minutes through the 24 hours the event may wait', () => {
    const options = fiscalReportJobOptions()
    expect(options.backoff.type).toBe('fixed')
    // Under the 15 minutes, with room for the call and the queue
    expect(options.backoff.delay).toBeLessThan(15 * 60 * 1000)
    expect(FiscalContingencyLimits.RETRY_INTERVAL_MS).toBe(15 * 60 * 1000)
    expect(options.attempts * options.backoff.delay).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000)
    expect(options.attempts).toBe(FiscalContingencyLimits.REPORT_MAX_ATTEMPTS)
    expect(options.removeOnFail.age).toBe(FiscalLimits.FAILED_JOB_KEEP_SECONDS)
  })

  it('asks again for a released document at a fixed interval under 15 minutes through the whole window of the lot', () => {
    const options = fiscalReleasedJobOptions()
    expect(options.backoff.type).toBe('fixed')
    expect(options.backoff.delay).toBeLessThan(FiscalContingencyLimits.RETRY_INTERVAL_MS)
    expect(options.attempts * options.backoff.delay).toBeGreaterThanOrEqual(
      FiscalContingencyLimits.RELEASED_RETRY_HOURS * 60 * 60 * 1000
    )
    expect(options.attempts).toBe(FiscalContingencyLimits.RELEASED_MAX_ATTEMPTS)
    expect(options.removeOnFail.age).toBe(FiscalLimits.FAILED_JOB_KEEP_SECONDS)
  })

  it('counts the attempts a document gets by where it is: a released one gets the attempts of its window', () => {
    expect(fiscalSubmitMaxAttempts(false)).toBe(FiscalLimits.MAX_ATTEMPTS)
    expect(fiscalSubmitMaxAttempts(true)).toBe(FiscalContingencyLimits.RELEASED_MAX_ATTEMPTS)
    expect(fiscalSubmitMaxAttempts(true)).toBeGreaterThan(fiscalSubmitMaxAttempts(false))
  })
})
