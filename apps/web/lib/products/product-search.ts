// The search box of the catalog page filters the rows already on the page by name or SKU, ignoring case and
// accents. The api's autocomplete (Step 4.1 search) will replace it and reach the products not yet loaded.
function plain(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

export function matchesProduct(
  product: { name: string; sku: string | null },
  query: string
): boolean {
  const needle = plain(query.trim())
  if (needle === '') return true
  return plain(product.name).includes(needle) || plain(product.sku ?? '').includes(needle)
}
