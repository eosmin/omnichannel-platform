// Every page of the channel directory, joined: it answers by pages of the creation order, so a case that looks for a row
// it just made must follow the cursor to the end (the store holds the connections of every case before it).
interface DirectoryPageBody {
  data: unknown[]
  nextCursor: string | null
}

export async function allDirectoryRows<T>(
  get: (query: { limit: number; cursor?: string }) => PromiseLike<{ status: number; body: unknown }>
): Promise<{ status: number; rows: T[] }> {
  const rows: T[] = []
  let cursor: string | undefined
  do {
    const page = await get({ limit: 100, ...(cursor === undefined ? {} : { cursor }) })
    if (page.status !== 200) return { status: page.status, rows }
    const body = page.body as DirectoryPageBody
    rows.push(...(body.data as T[]))
    cursor = body.nextCursor ?? undefined
  } while (cursor !== undefined)
  return { status: 200, rows }
}
