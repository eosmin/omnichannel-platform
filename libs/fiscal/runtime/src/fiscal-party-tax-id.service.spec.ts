import { FiscalPartyTaxIdService } from './fiscal-party-tax-id.service'
import type { FiscalProviderRegistry } from './fiscal-provider.registry'

type Provider = { validatePartyTaxId?: (taxId: string) => boolean }

function build(issuerProvider: string | null, provider: Provider | undefined) {
  const tx = {
    fiscalIssuer: {
      findUnique: jest.fn(() =>
        Promise.resolve(issuerProvider === null ? null : { providerId: issuerProvider })
      )
    }
  }
  const registry = { find: jest.fn(() => provider) }
  const logger = { setContext: jest.fn(), error: jest.fn() }
  const service = new FiscalPartyTaxIdService(
    registry as unknown as FiscalProviderRegistry,
    logger as never
  )
  return { service, tx, registry, logger }
}

describe('FiscalPartyTaxIdService', () => {
  const noSpaces = { validatePartyTaxId: (taxId: string) => !taxId.includes(' ') }

  it('asks the provider of the issuer of the organization', async () => {
    const { service, tx, registry } = build('p1', noSpaces)

    expect(await service.isPlausible(tx as never, 'org-1', 'a-b')).toBe(true)
    expect(await service.isPlausible(tx as never, 'org-1', 'a b')).toBe(false)
    expect(tx.fiscalIssuer.findUnique).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      select: { providerId: true }
    })
    expect(registry.find).toHaveBeenCalledWith('p1')
  })

  it('accepts anything when the organization has no issuer', async () => {
    const { service, tx } = build(null, noSpaces)

    expect(await service.isPlausible(tx as never, 'org-1', 'a b')).toBe(true)
  })

  it('accepts anything when the provider is unknown or has no rule', async () => {
    const gone = build('gone', undefined)
    expect(await gone.service.isPlausible(gone.tx as never, 'org-1', 'a b')).toBe(true)
    const noRule = build('p1', {})
    expect(await noRule.service.isPlausible(noRule.tx as never, 'org-1', 'a b')).toBe(true)
  })

  it('answers unavailable, and logs no message, when the provider throws on the value', async () => {
    const { service, tx, logger } = build('p1', {
      validatePartyTaxId: () => {
        throw new Error('cannot parse SECRET-VALUE')
      }
    })

    await expect(service.isPlausible(tx as never, 'org-1', 'SECRET-VALUE')).rejects.toMatchObject({
      code: 'FISCAL_PROVIDER_UNAVAILABLE'
    })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('SECRET-VALUE')
  })
})
