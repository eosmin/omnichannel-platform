import { countsOf } from './customer-media.views'

describe('countsOf', () => {
  it('counts each tab and the total, under the content types of the groups', () => {
    expect(
      countsOf([
        { contentType: 'image/png', _count: { _all: 3 } },
        { contentType: 'image/jpeg', _count: { _all: 2 } },
        { contentType: 'video/mp4', _count: { _all: 1 } },
        { contentType: 'application/pdf', _count: { _all: 4 } }
      ])
    ).toEqual({ all: 10, image: 5, video: 1, audio: 0, document: 4 })
  })

  it('is all zeros for no files', () => {
    expect(countsOf([])).toEqual({ all: 0, image: 0, video: 0, audio: 0, document: 0 })
  })

  it('counts a file of a type no tab lists in the total only', () => {
    expect(countsOf([{ contentType: 'application/zip', _count: { _all: 2 } }])).toEqual({
      all: 2,
      image: 0,
      video: 0,
      audio: 0,
      document: 0
    })
  })
})
