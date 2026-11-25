import {
  FiscalContingencyLimits,
  fiscalJobOptions,
  FiscalLimits,
  fiscalReportJobOptions
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
})
