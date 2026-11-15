import type { CountDetailView, CountPage, CountView } from './counts.views'

// A count as a plugin reads it: the fields of the screen except `createdBy` and `appliedBy`, the ids of the people of the team who
// opened and approved it (see `plugin-transfers.views.ts`). The fields are named one by one, so a column added to the views of the
// screen does not reach a plugin until someone decides it should.
export type PluginCountView = Omit<
  CountView,
  'createdBy' | 'createdByPluginId' | 'appliedBy' | 'appliedByPluginId'
>
export type PluginCountDetailView = Omit<
  CountDetailView,
  'createdBy' | 'createdByPluginId' | 'appliedBy' | 'appliedByPluginId'
>
export type PluginCountPage = Omit<CountPage, 'data'> & { data: PluginCountView[] }

export function pluginCountView(count: CountView): PluginCountView {
  return {
    id: count.id,
    number: count.number,
    status: count.status,
    warehouse: count.warehouse,
    storeId: count.storeId,
    storeName: count.storeName,
    note: count.note,
    startedAt: count.startedAt,
    submittedAt: count.submittedAt,
    appliedAt: count.appliedAt,
    createdAt: count.createdAt,
    updatedAt: count.updatedAt
  }
}

export function pluginCountDetailView(count: CountDetailView): PluginCountDetailView {
  return {
    ...pluginCountView(count),
    totals: count.totals,
    lines: count.lines,
    nextCursor: count.nextCursor,
    hasMore: count.hasMore
  }
}

export function pluginCountPage(page: CountPage): PluginCountPage {
  return { ...page, data: page.data.map(pluginCountView) }
}
