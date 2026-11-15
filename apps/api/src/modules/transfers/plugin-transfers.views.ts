import type { TransferPage, TransferSummaryView, TransferView } from './transfers.views'

// A transfer as a plugin reads it: the fields of the screen except `createdBy` and `dispatchedBy`, the ids of the people of the team
// who made and sent it, and the ids of the plugin that did when it was one (`...PluginId`: a plugin is not told which other plugin
// moved the stock of its store). A transfer a plugin makes carries no person, so the keys are absent for every transfer rather than for some. The fields are named one by one, so a column added
// to the views of the screen does not reach a plugin until someone decides it should.
export type PluginTransferSummaryView = Omit<
  TransferSummaryView,
  'createdBy' | 'createdByPluginId' | 'dispatchedBy' | 'dispatchedByPluginId'
>
export type PluginTransferView = Omit<
  TransferView,
  'createdBy' | 'createdByPluginId' | 'dispatchedBy' | 'dispatchedByPluginId'
>
export type PluginTransferPage = Omit<TransferPage, 'data'> & { data: PluginTransferSummaryView[] }

export function pluginTransferSummary(transfer: TransferSummaryView): PluginTransferSummaryView {
  return {
    id: transfer.id,
    number: transfer.number,
    status: transfer.status,
    fromWarehouse: transfer.fromWarehouse,
    toWarehouse: transfer.toWarehouse,
    note: transfer.note,
    dispatchedAt: transfer.dispatchedAt,
    closedAt: transfer.closedAt,
    createdAt: transfer.createdAt,
    updatedAt: transfer.updatedAt,
    lineCount: transfer.lineCount
  }
}

export function pluginTransferView(transfer: TransferView): PluginTransferView {
  return {
    id: transfer.id,
    number: transfer.number,
    status: transfer.status,
    fromWarehouse: transfer.fromWarehouse,
    toWarehouse: transfer.toWarehouse,
    note: transfer.note,
    dispatchedAt: transfer.dispatchedAt,
    closedAt: transfer.closedAt,
    createdAt: transfer.createdAt,
    updatedAt: transfer.updatedAt,
    lines: transfer.lines
  }
}

export function pluginTransferPage(page: TransferPage): PluginTransferPage {
  return { ...page, data: page.data.map(pluginTransferSummary) }
}
