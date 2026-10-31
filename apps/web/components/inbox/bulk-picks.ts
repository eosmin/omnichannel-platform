// The actions of the bulk bar that need a person or a tag chosen first. They live apart from the dialog
// so that the bar can name them without loading the dialog.
export const BulkPicks = {
  AGENT: 'agent',
  TEAM: 'team',
  ADD_TAG: 'add_tag',
  REMOVE_TAG: 'remove_tag'
} as const
export type BulkPick = (typeof BulkPicks)[keyof typeof BulkPicks]
