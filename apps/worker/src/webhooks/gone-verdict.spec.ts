import { GoneVerdict, judgeGone } from './gone-verdict'

const policyRefusal = {
  code: 'P2010',
  meta: { driverAdapterError: { cause: { originalCode: '42501' } } }
}

describe('judgeGone', () => {
  it.each(['P2025', 'P2003'])(
    'takes %s for a row that was deleted, without looking again',
    async code => {
      const stillThere = jest.fn(() => Promise.resolve(true))

      await expect(judgeGone({ code }, stillThere)).resolves.toBe(GoneVerdict.DELETED)
      expect(stillThere).not.toHaveBeenCalled()
    }
  )

  it('takes a refusal of the policy for a deleted row when the parent is no longer there', async () => {
    await expect(judgeGone(policyRefusal, () => Promise.resolve(false))).resolves.toBe(
      GoneVerdict.DELETED_BEHIND_POLICY
    )
  })

  it('does not take a refusal of the policy for a deleted row when the parent is still there', async () => {
    await expect(judgeGone(policyRefusal, () => Promise.resolve(true))).resolves.toBe(
      GoneVerdict.NOT_GONE
    )
  })

  it('keeps the original error when the look-up itself fails', async () => {
    await expect(judgeGone(policyRefusal, () => Promise.reject(new Error('down')))).resolves.toBe(
      GoneVerdict.NOT_GONE
    )
  })

  it.each([
    ['an unknown database error', { code: 'P2002' }],
    ['a plain error', new Error('boom')]
  ])('does not look again for %s', async (_name, error) => {
    const stillThere = jest.fn(() => Promise.resolve(false))

    await expect(judgeGone(error, stillThere)).resolves.toBe(GoneVerdict.NOT_GONE)
    expect(stillThere).not.toHaveBeenCalled()
  })
})
