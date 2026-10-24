import { MediaPurpose } from './media-purpose'

describe('MediaPurpose', () => {
  it('has the shipping purposes and unique values', () => {
    const values: string[] = Object.values(MediaPurpose)
    expect(new Set(values).size).toBe(values.length)
    expect(values).toEqual(
      expect.arrayContaining(['shipping_label', 'bulk_labels', 'remittance_file'])
    )
  })
})
