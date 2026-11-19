import { FinanceConflicts } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import { FinanceSetupService } from './finance-setup.service'

// A row of the chart collides (ledger_accounts_organization_id_code_key) with one this organization's read could not see:
// the books are set up already, a 409, never a 500.
const UNIQUE_VIOLATION = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })

const actor = { userId: 'u', storeId: 's', ipAddress: null, userAgent: null } as never

function serviceWith(transaction: jest.Mock): FinanceSetupService {
  const prisma = { transaction, client: {} }
  const audit = { log: jest.fn() }
  return new FinanceSetupService(prisma as never, audit as never)
}

describe('FinanceSetupService.setup: a chart row out of sight', () => {
  it('answers 409 ALREADY_SET_UP when the insert of the chart collides', async () => {
    const transaction = jest.fn().mockRejectedValue(UNIQUE_VIOLATION)
    const failure: unknown = await serviceWith(transaction)
      .setup('org-1', { countryCode: 'SV', accountingStartDate: '2026-01-01' }, actor)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PlatformException)
    expect((failure as PlatformException).statusCode).toBe(HttpStatusCodes.CONFLICT)
    expect((failure as PlatformException).metadata).toEqual({
      conflict: FinanceConflicts.ALREADY_SET_UP
    })
    expect((failure as PlatformException).code).not.toBe(ErrorCodes.INTERNAL_ERROR)
  })

  it('lets any other failure through', async () => {
    const boom = new Error('connection lost')
    const transaction = jest.fn().mockRejectedValue(boom)
    await expect(
      serviceWith(transaction).setup(
        'org-1',
        { countryCode: 'SV', accountingStartDate: '2026-01-01' },
        actor
      )
    ).rejects.toBe(boom)
  })
})
