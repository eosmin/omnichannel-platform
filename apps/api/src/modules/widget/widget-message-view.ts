import { AuthorType, type WidgetAuthor, WidgetAuthors } from '@platform/core/domain'

// A message as the visitor sees it: who (their side or the store's), what, and when. Nothing about the
// agents or the conversation leaves.
export interface WidgetMessageView {
  id: string
  from: WidgetAuthor
  content: string
  createdAt: string
}

interface MessageRow {
  id: string
  content: string | null
  authorType: string
  createdAt: Date
}

// A message with no text has nothing to show a visitor (files wait for Step 3.4)
export function widgetMessageView(row: MessageRow): WidgetMessageView | null {
  if (row.content === null) return null
  return {
    id: row.id,
    from:
      row.authorType === String(AuthorType.CUSTOMER) ? WidgetAuthors.VISITOR : WidgetAuthors.TEAM,
    content: row.content,
    createdAt: row.createdAt.toISOString()
  }
}
