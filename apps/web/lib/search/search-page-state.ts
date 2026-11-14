import {
  SearchEntities,
  type SearchEntity,
  SearchPageParams,
  type SearchPageScope,
  SearchPageScopes
} from '@platform/core/domain'

// The address of the results page, read. A scope the member may not search (or that does not exist) is `all`, so an
// edited address never shows a tab that is not offered.
export function readScope(value: string | null, allowed: readonly SearchEntity[]): SearchPageScope {
  const entity = Object.values(SearchEntities).find(kind => kind === value)
  return entity !== undefined && allowed.includes(entity) ? entity : SearchPageScopes.ALL
}

// The address for a text and a scope: `all` is the default, so it is not written
export function searchAddress(base: string, text: string, scope: SearchPageScope): string {
  const params = new URLSearchParams()
  if (text !== '') params.set(SearchPageParams.QUERY, text)
  if (scope !== SearchPageScopes.ALL) params.set(SearchPageParams.SCOPE, scope)
  const query = params.toString()
  return query === '' ? base : `${base}?${query}`
}
