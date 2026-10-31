import dynamic from 'next/dynamic'

import { ConversationPaneLoading } from './conversation-pane-loading'

// The dialogs and panes of the inbox, loaded the first time one is rendered. The inbox has a script budget
// (apps/web-e2e/lighthouse/budgets.ts) and none of these is on screen when the page loads. Render
// each one only once it is wanted (useMountedOnce), or it is downloaded with the page anyway.
export const BulkPickDialog = dynamic(
  () => import('./bulk-pick-dialog').then(module => module.BulkPickDialog),
  { ssr: false }
)

export const BulkConfirmDialog = dynamic(
  () => import('./bulk-confirm-dialog').then(module => module.BulkConfirmDialog),
  { ssr: false }
)

export const SnoozeDialog = dynamic(
  () => import('./snooze-dialog').then(module => module.SnoozeDialog),
  { ssr: false }
)

export const TemplateDialog = dynamic(
  () => import('./template-dialog').then(module => module.TemplateDialog),
  { ssr: false }
)

export const ShortcutHelp = dynamic(
  () => import('./shortcut-help').then(module => module.ShortcutHelp),
  { ssr: false }
)

export const ConversationPane = dynamic(
  () => import('./conversation-pane').then(module => module.ConversationPane),
  { ssr: false, loading: () => <ConversationPaneLoading /> }
)
