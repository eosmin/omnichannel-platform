import { FiscalEnvironment, FiscalIssueOn, FiscalLimits } from './fiscal-constants'
import {
  fiscalReceiverPatchSchema,
  listFiscalDocumentsQuerySchema,
  putFiscalIssuerSchema,
  voidFiscalDocumentSchema
} from './fiscal-schemas'

const issuer = {
  providerId: 'p',
  legalName: 'Shop',
  taxId: '1',
  address: { line1: 'Street 1' },
  environment: FiscalEnvironment.SANDBOX
}

describe('the fiscal schemas', () => {
  it('takes an issuer with the defaults the api gives it', () => {
    const parsed = putFiscalIssuerSchema.parse(issuer)
    expect(parsed.issueOn).toBe(FiscalIssueOn.DELIVERED)
    expect(parsed.registrationId).toBeNull()
  })

  it('refuses a field it does not know, a correlative out of range and a long address line', () => {
    expect(putFiscalIssuerSchema.safeParse({ ...issuer, extra: 1 }).success).toBe(false)
    expect(
      putFiscalIssuerSchema.safeParse({ ...issuer, nextSequence: FiscalLimits.MAX_SEQUENCE + 1 })
        .success
    ).toBe(false)
    expect(
      putFiscalIssuerSchema.safeParse({ ...issuer, address: { line1: 'x'.repeat(201) } }).success
    ).toBe(false)
  })

  it('refuses a receiver change with nothing in it, and takes null to remove a field', () => {
    expect(fiscalReceiverPatchSchema.safeParse({}).success).toBe(false)
    expect(fiscalReceiverPatchSchema.safeParse({ email: null }).success).toBe(true)
  })

  it('needs a reason to void', () => {
    expect(voidFiscalDocumentSchema.safeParse({ reason: '  ' }).success).toBe(false)
    expect(voidFiscalDocumentSchema.safeParse({ reason: 'wrong receiver' }).success).toBe(true)
  })

  it('lists with a page size by default and a cursor that is a correlative', () => {
    expect(listFiscalDocumentsQuerySchema.parse({}).limit).toBe(FiscalLimits.LIST_PAGE_SIZE)
    expect(listFiscalDocumentsQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(false)
  })
})
