// A store can have hundreds of tags: from this many on, the tags a customer can still take get a search box,
// and only the first ones of the result are drawn (a list of two hundred buttons is not a choice)
export const TAG_SEARCH_FROM = 12
export const TAG_LIST_LIMIT = 30

// Only the combining accents come off (`\u0300`-`\u036f`): a symbol such as `^` is part of a name
const plain = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

// The tags whose name holds what was typed, without caring for capitals or accents, in the order they came
export function filterTags<T extends { name: string }>(tags: readonly T[], query: string): T[] {
  const wanted = plain(query.trim())
  return wanted === '' ? [...tags] : tags.filter(tag => plain(tag.name).includes(wanted))
}
