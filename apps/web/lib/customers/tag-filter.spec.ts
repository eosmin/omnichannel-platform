import { filterTags } from './tag-filter'

const tags = [{ name: 'VIP' }, { name: 'Mayorista' }, { name: 'Cotización' }, { name: 'Moroso' }]

describe('filterTags', () => {
  it('keeps every tag, in order, for an empty or blank search', () => {
    expect(filterTags(tags, '')).toEqual(tags)
    expect(filterTags(tags, '   ')).toEqual(tags)
  })

  it('finds a part of the name without caring for capitals', () => {
    expect(filterTags(tags, 'vi')).toEqual([{ name: 'VIP' }])
    expect(filterTags(tags, 'MAYOR')).toEqual([{ name: 'Mayorista' }])
  })

  it('ignores accents on both sides', () => {
    expect(filterTags(tags, 'cotizacion')).toEqual([{ name: 'Cotización' }])
    expect(filterTags([{ name: 'Cafe' }], 'café')).toEqual([{ name: 'Cafe' }])
  })

  it('does not read a symbol as an accent: searching for it narrows the list', () => {
    expect(filterTags([{ name: 'C++' }, { name: 'Go^' }], '^')).toEqual([{ name: 'Go^' }])
  })

  it('answers nothing when no name holds the text', () => {
    expect(filterTags(tags, 'zzz')).toEqual([])
  })
})
