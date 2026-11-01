import {
  downloadAllBodySchema,
  galleryContentTypes,
  GalleryLimits,
  galleryTypeOf,
  GalleryTypes
} from './media-gallery'
import { AllowedContentTypes } from './upload-constants'

const CUSTOMER = '0b2f3d3e-6a3c-4c1e-9d5e-2a4f6f0c9b11'

describe('gallery tabs', () => {
  it('lists the content types of a tab and none for "all"', () => {
    expect(galleryContentTypes(GalleryTypes.ALL)).toBeNull()
    expect(galleryContentTypes(GalleryTypes.IMAGE)).toEqual(AllowedContentTypes.IMAGE)
    expect(galleryContentTypes(GalleryTypes.DOCUMENT)).toEqual(AllowedContentTypes.DOCUMENT)
  })

  it('puts every allowed type in exactly one tab', () => {
    for (const types of Object.values(AllowedContentTypes)) {
      for (const type of types) {
        const tabs = [
          GalleryTypes.IMAGE,
          GalleryTypes.VIDEO,
          GalleryTypes.AUDIO,
          GalleryTypes.DOCUMENT
        ].filter(tab => galleryContentTypes(tab)?.includes(type) === true)
        expect(tabs).toHaveLength(1)
        expect(galleryTypeOf(type)).toBe(tabs[0])
      }
    }
  })

  it('has no tab for a type that is not allowed', () => {
    expect(galleryTypeOf('application/x-msdownload')).toBeNull()
  })
})

describe('downloadAllBodySchema', () => {
  it('takes a customer, and a tab and a search as options', () => {
    expect(downloadAllBodySchema.parse({ customerId: CUSTOMER })).toEqual({ customerId: CUSTOMER })
    expect(
      downloadAllBodySchema.parse({ customerId: CUSTOMER, type: 'image', q: ' zapato ' })
    ).toEqual({ customerId: CUSTOMER, type: 'image', q: 'zapato' })
  })

  it('refuses what is not a customer id, an unknown tab, an empty or long search, a store id', () => {
    const bad = [
      {},
      { customerId: 'x' },
      { customerId: CUSTOMER, type: 'pdf' },
      { customerId: CUSTOMER, q: '  ' },
      { customerId: CUSTOMER, q: 'a'.repeat(GalleryLimits.SEARCH_MAX_LENGTH + 1) },
      { customerId: CUSTOMER, storeId: CUSTOMER }
    ]
    for (const body of bad) expect(downloadAllBodySchema.safeParse(body).success).toBe(false)
  })
})
