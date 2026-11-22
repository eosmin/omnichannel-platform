import { FiscalReceiverMask, maskReceiverName, maskReceiverTaxId } from './fiscal-masks'

describe('the mask of a receiver', () => {
  it('shows the first letter of a name and has the same length whatever the name', () => {
    const short = maskReceiverName('Al')
    const long = maskReceiverName('Maria de los Angeles Fernandez Rodriguez')
    expect(short).toBe('A***********')
    expect(long).toBe('M***********')
    expect(short?.length).toBe(FiscalReceiverMask.LENGTH)
    expect(long?.length).toBe(FiscalReceiverMask.LENGTH)
    // the first character as a person writes it: an accent, or a character outside the basic plane, is one
    expect(maskReceiverName('Álvaro')).toBe('Á***********')
    expect(maskReceiverName('𠮷野 家')).toBe('𠮷***********')
  })

  it('shows nothing for a blank or missing name', () => {
    expect(maskReceiverName(null)).toBeNull()
    expect(maskReceiverName(undefined)).toBeNull()
    expect(maskReceiverName('   ')).toBeNull()
  })

  it('shows the last four digits of a tax id of nine digits or more, in a mask of fixed length', () => {
    expect(maskReceiverTaxId('0614-290589-102-3')).toBe('********1023')
    expect(maskReceiverTaxId('012345678')).toBe('********5678')
    expect(maskReceiverTaxId('0123456789012345678')).toBe('********5678')
    for (const id of ['012345678', '0614-290589-102-3', '0123456789012345678']) {
      expect(maskReceiverTaxId(id)?.length).toBe(FiscalReceiverMask.LENGTH)
    }
  })

  it('gives the same mask to two different tax ids that end in the same four digits', () => {
    expect(maskReceiverTaxId('111111111-1234')).toBe(maskReceiverTaxId('999999999999-1234'))
    expect(maskReceiverTaxId('111111111-1234')).not.toBe(maskReceiverTaxId('111111111-1235'))
  })

  it('shows nothing of a tax id with fewer than nine digits, whatever else it holds', () => {
    expect(maskReceiverTaxId('12345678')).toBeNull()
    expect(maskReceiverTaxId('AB-1234-CD-5678')).toBeNull()
    expect(maskReceiverTaxId('')).toBeNull()
    expect(maskReceiverTaxId(null)).toBeNull()
  })
})
