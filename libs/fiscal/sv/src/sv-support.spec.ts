import { activityName, isDepartment, isDistrict, isMunicipality, isUnit } from './sv-catalog'
import { allocate, dollars, dollars8, roundDiv, toScaled8 } from './sv-decimal'
import { addressOf, digitsOf, identityOf, issuerProblems, receiverProblems } from './sv-parties'
import { salvadorMoment } from './sv-time'
import { amountInWords } from './sv-words'
import { BUSINESS, CONSUMER, ISSUER } from './testing/sv-fixtures'

describe('the arithmetic of the figures', () => {
  it('rounds halves up and never through a float', () => {
    expect(roundDiv(5n, 2n)).toBe(3n)
    expect(roundDiv(4n, 3n)).toBe(1n)
    expect(roundDiv(1n, 3n)).toBe(0n)
    // 1.125 -> 1.13 and 5.665 -> 5.67, the examples of the functional manual
    expect(roundDiv(1125n, 10n)).toBe(113n)
    expect(roundDiv(5665n, 10n)).toBe(567n)
    expect(() => roundDiv(-1n, 2n)).toThrow(RangeError)
    expect(() => roundDiv(1n, 0n)).toThrow(RangeError)
  })

  it('writes cents and eight decimals as the numbers the JSON holds', () => {
    expect(dollars(2825)).toBe(28.25)
    expect(dollars(5)).toBe(0.05)
    expect(dollars8(294690265n)).toBe(2.94690265)
    expect(dollars8(toScaled8(1130))).toBe(11.3)
    expect(JSON.stringify(dollars8(roundDiv(333n * 100_000_000n, 113n)))).toBe('2.94690265')
  })

  it('splits by the largest remainder: whole parts that add up, the same every time', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33])
    expect(allocate(1, [3, 3])).toEqual([1, 0])
    expect(allocate(0, [5, 5])).toEqual([0, 0])
    expect(allocate(7, [2260, 1000])).toEqual([5, 2])
    for (const total of [1, 99, 100, 12345]) {
      const parts = allocate(total, [333, 999, 1130, 7])
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total)
    }
    expect(() => allocate(5, [0, 0])).toThrow(RangeError)
    expect(() => allocate(-1, [1])).toThrow(RangeError)
  })
})

describe('the time of El Salvador', () => {
  it('is six hours behind UTC the whole year', () => {
    expect(salvadorMoment('2026-11-17T03:30:15.000Z')).toEqual({
      date: '2026-11-16',
      time: '21:30:15'
    })
    expect(salvadorMoment('2026-07-01T12:00:00.000Z')).toEqual({
      date: '2026-07-01',
      time: '06:00:00'
    })
    expect(salvadorMoment('2026-01-01T05:59:59.000Z')).toEqual({
      date: '2025-12-31',
      time: '23:59:59'
    })
    expect(() => salvadorMoment('not a date')).toThrow(RangeError)
  })
})

describe('the amount in words', () => {
  it.each([
    [0, 'CERO 00/100 DÓLARES'],
    [100, 'UNO 00/100 DÓLARES'],
    [2825, 'VEINTIOCHO 25/100 DÓLARES'],
    [10000, 'CIEN 00/100 DÓLARES'],
    [10100, 'CIENTO UNO 00/100 DÓLARES'],
    [12345, 'CIENTO VEINTITRÉS 45/100 DÓLARES'],
    [100000, 'MIL 00/100 DÓLARES'],
    [2100000, 'VEINTIÚN MIL 00/100 DÓLARES'],
    [5240000, 'CINCUENTA Y DOS MIL CUATROCIENTOS 00/100 DÓLARES'],
    [100000000, 'UN MILLÓN 00/100 DÓLARES'],
    [250000099, 'DOS MILLONES QUINIENTOS MIL 99/100 DÓLARES'],
    [5, 'CERO 05/100 DÓLARES']
  ])('writes %s cents as %s', (cents, words) => {
    expect(amountInWords(cents)).toBe(words)
  })

  it('refuses an amount out of range', () => {
    expect(() => amountInWords(-1)).toThrow(RangeError)
    expect(() => amountInWords(1.5)).toThrow(RangeError)
    expect(() => amountInWords(100_000_000_000)).toThrow(RangeError)
  })
})

describe('the catalogs of the authority', () => {
  it('know the departments, the municipalities of each, the districts, the units and the activities', () => {
    expect(isDepartment('06')).toBe(true)
    expect(isDepartment('99')).toBe(false)
    // The code of a municipality repeats across departments: 14 is Ahuachapán Centro and Santa Ana Norte, and means nothing in San Salvador
    expect(isMunicipality('01', '14')).toBe(true)
    expect(isMunicipality('02', '14')).toBe(true)
    expect(isMunicipality('06', '14')).toBe(false)
    expect(isDistrict('01')).toBe(true)
    expect(isDistrict('9999')).toBe(false)
    expect(isUnit(59)).toBe(true)
    expect(isUnit(0)).toBe(false)
    expect(activityName('47119')).toBe('Almacenes (venta de diversos artículos)')
    expect(activityName('00000')).toBeNull()
  })
})

describe('the issuer and the receiver as the authority reads them', () => {
  it('reads an address as four parts that are in the catalogs, and nothing else', () => {
    expect(addressOf(ISSUER.address)).toEqual({
      departamento: '06',
      municipio: '23',
      distrito: '01',
      complemento: 'Calle 1, Colonia Centro'
    })
    expect(addressOf({ ...ISSUER.address, municipality: '99' })).toBeNull()
    expect(addressOf({ ...ISSUER.address, complement: ' ' })).toBeNull()
    expect(addressOf({ ...ISSUER.address, complement: 'x'.repeat(201) })).toBeNull()
    expect(addressOf({})).toBeNull()
    expect(addressOf(null)).toBeNull()
  })

  it('reads a tax id as digits: 14 of a tax number, 9 of a national id, and another document as it is written', () => {
    expect(digitsOf('0614-010101-101-1')).toBe('06140101011011')
    expect(identityOf('0614-010101-101-1', null)).toEqual({ type: '36', number: '06140101011011' })
    expect(identityOf('01234567-8', null)).toEqual({ type: '13', number: '012345678' })
    expect(identityOf('01234567-8', '13')).toEqual({ type: '13', number: '012345678' })
    expect(identityOf('0614-010101-101-1', '13')).toBeNull()
    expect(identityOf('123', null)).toBeNull()
    expect(identityOf(' ', null)).toBeNull()
    expect(identityOf('AB1234567', '03')).toEqual({ type: '03', number: 'AB1234567' })
    expect(identityOf('x'.repeat(21), '03')).toBeNull()
  })

  it('says what is wrong in a receiver by field and code, never by value, and nothing for what is not filled', () => {
    expect(receiverProblems(CONSUMER)).toEqual([])
    expect(receiverProblems(BUSINESS)).toEqual([])
    const wrong = receiverProblems({
      ...BUSINESS,
      taxId: 'SECRET-1',
      registrationId: '1',
      economicActivity: '00000',
      email: 'no-at-sign',
      phone: '123',
      address: { department: '06', municipality: '99', district: '01', complement: 'x' }
    })
    expect(wrong.map(problem => problem.field).sort()).toEqual(
      ['address', 'economicActivity', 'email', 'phone', 'registrationId', 'taxId'].sort()
    )
    expect(JSON.stringify(wrong)).not.toContain('SECRET')
  })

  it('refuses a kind of identity document the catalog does not have', () => {
    expect(receiverProblems({ ...BUSINESS, documentType: '77' })).toEqual([
      { field: 'documentType', code: 'document_type_unknown' }
    ])
  })

  it('names what an issuer lacks to make a document, and nothing for a complete one', () => {
    expect(issuerProblems(ISSUER)).toEqual([])
    expect(
      issuerProblems({
        ...ISSUER,
        legalName: '',
        taxId: '1',
        registrationId: null,
        activityCode: null,
        address: {},
        establishmentCode: 'X001',
        pointOfSaleCode: 'M001',
        phone: null,
        email: 'a'
      }).sort()
    ).toEqual(
      [
        'legalName',
        'taxId',
        'registrationId',
        'activityCode',
        'address',
        'establishmentCode',
        'pointOfSaleCode',
        'phone',
        'email'
      ].sort()
    )
  })
})
