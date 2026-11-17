import { FiscalEnvironment, FiscalIssueOn, FiscalLimits } from './fiscal-constants'
import {
  confirmFiscalIssuerChangeSchema,
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
    // Not named, not changed: the service keeps the stored one and a new issuer starts at delivered
    expect(parsed.issueOn).toBeUndefined()
    expect(putFiscalIssuerSchema.parse({ ...issuer, issueOn: FiscalIssueOn.SHIPPED }).issueOn).toBe(
      FiscalIssueOn.SHIPPED
    )
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

  it('leaves the point of sale and the contact of the issuer out, sets them, or clears them with null (Step 4B.7c-1)', () => {
    const none = putFiscalIssuerSchema.parse(issuer)
    // Left out they are undefined (the service keeps the stored ones), never null: a form that does not know them wipes nothing
    expect(none.pointOfSaleCode).toBeUndefined()
    expect(none.phone).toBeUndefined()
    const set = putFiscalIssuerSchema.parse({
      ...issuer,
      establishmentType: 'branch',
      pointOfSaleCode: 'P001',
      phone: '2222-0000',
      email: 'billing@example.test'
    })
    expect(set).toMatchObject({ pointOfSaleCode: 'P001', phone: '2222-0000' })
    expect(putFiscalIssuerSchema.parse({ ...issuer, phone: null }).phone).toBeNull()
    expect(putFiscalIssuerSchema.safeParse({ ...issuer, phone: '' }).success).toBe(false)
    expect(putFiscalIssuerSchema.safeParse({ ...issuer, email: 'x'.repeat(201) }).success).toBe(
      false
    )
  })

  it('takes the kind of identity document in a receiver change, and null to remove it', () => {
    expect(fiscalReceiverPatchSchema.parse({ documentType: 'passport' })).toEqual({
      documentType: 'passport'
    })
    expect(fiscalReceiverPatchSchema.parse({ documentType: null })).toEqual({ documentType: null })
    expect(fiscalReceiverPatchSchema.safeParse({ documentType: 'x'.repeat(41) }).success).toBe(
      false
    )
  })

  it('refuses a receiver change with nothing in it, and takes null to remove a field', () => {
    expect(fiscalReceiverPatchSchema.safeParse({}).success).toBe(false)
    expect(fiscalReceiverPatchSchema.safeParse({ email: null }).success).toBe(true)
  })

  it('needs a reason to void', () => {
    expect(voidFiscalDocumentSchema.safeParse({ reason: '  ' }).success).toBe(false)
    expect(voidFiscalDocumentSchema.safeParse({ reason: 'wrong receiver' }).success).toBe(true)
    // The kind, the people and the replacement a provider may ask for: optional, strict, and one line each
    const party = { name: 'Ana', idType: '13', idNumber: '1' }
    const full = {
      reason: 'wrong receiver',
      kind: 'rescission',
      responsible: party,
      requester: party,
      replacementDocumentId: '2b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'
    }
    expect(voidFiscalDocumentSchema.safeParse(full).success).toBe(true)
    for (const bad of [
      { ...full, kind: 'nope' },
      { ...full, responsible: { ...party, idNumber: '' } },
      { ...full, requester: { ...party, name: 'a'.repeat(101) } },
      { ...full, requester: { ...party, idNumber: '1'.repeat(21) } },
      { ...full, responsible: { ...party, extra: 1 } },
      { ...full, replacementDocumentId: 'x' },
      { ...full, extra: 1 }
    ]) {
      expect(voidFiscalDocumentSchema.safeParse(bad).success).toBe(false)
    }
  })

  it('needs a reason to confirm an issuer change, and takes nothing else', () => {
    expect(confirmFiscalIssuerChangeSchema.safeParse({ reason: '  ' }).success).toBe(false)
    expect(confirmFiscalIssuerChangeSchema.safeParse({ reason: 'not there' }).success).toBe(true)
    expect(
      confirmFiscalIssuerChangeSchema.safeParse({ reason: 'not there', extra: 1 }).success
    ).toBe(false)
    expect(
      confirmFiscalIssuerChangeSchema.safeParse({
        reason: 'a'.repeat(FiscalLimits.VOID_REASON_MAX_LENGTH + 1)
      }).success
    ).toBe(false)
  })

  it('lists with a page size by default and a cursor that is a correlative', () => {
    expect(listFiscalDocumentsQuerySchema.parse({}).limit).toBe(FiscalLimits.LIST_PAGE_SIZE)
    expect(listFiscalDocumentsQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(false)
  })

  it('takes a period of ISO instants, open at either end, and refuses one that ends before it starts or is not a date', () => {
    const parse = (query: Record<string, string>) => listFiscalDocumentsQuerySchema.safeParse(query)
    expect(parse({}).success).toBe(true)
    expect(parse({ from: '2026-01-01T00:00:00.000Z' }).success).toBe(true)
    expect(parse({ to: '2026-01-31T23:59:59-06:00' }).success).toBe(true)
    expect(parse({ from: '2026-01-31T00:00:00Z', to: '2026-01-31T00:00:00Z' }).success).toBe(true)
    expect(parse({ from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }).success).toBe(false)
    expect(parse({ from: '2026-01-01' }).success).toBe(false)
    expect(parse({ to: 'tomorrow' }).success).toBe(false)
    expect(parse({ from: '2026-13-01T00:00:00Z' }).success).toBe(false)
  })
})
