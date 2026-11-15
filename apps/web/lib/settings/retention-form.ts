import { RetentionBounds, type RetentionField } from '@platform/core/domain'

import type { RetentionView } from './retention-requests'

// The form of Settings → Data retention: four windows in days. The fields are text while the person types, so an empty or
// half-typed box is a problem to show and not a number to guess. The same limits are checked by the api and by the database.

export const RETENTION_FIELDS: readonly RetentionField[] = [
  'conversationDays',
  'mediaDays',
  'analyticsDays',
  'notificationDays'
]

export type RetentionDraft = Record<RetentionField, string>

export type RetentionProblem = 'required' | 'whole' | 'tooLow' | 'tooHigh'

export function retentionDraftOf(view: RetentionView): RetentionDraft {
  return {
    conversationDays: String(view.conversationDays),
    mediaDays: String(view.mediaDays),
    analyticsDays: String(view.analyticsDays),
    notificationDays: String(view.notificationDays)
  }
}

// Digits only: a sign, a decimal point or an exponent is not a number of days
const WHOLE_NUMBER = /^\d+$/

export function retentionProblem(field: RetentionField, text: string): RetentionProblem | null {
  const typed = text.trim()
  if (typed === '') return 'required'
  if (!WHOLE_NUMBER.test(typed)) return 'whole'
  const days = Number(typed)
  if (days < RetentionBounds[field].min) return 'tooLow'
  if (days > RetentionBounds[field].max) return 'tooHigh'
  return null
}

export function retentionProblems(
  draft: RetentionDraft
): Partial<Record<RetentionField, RetentionProblem>> {
  const found: Partial<Record<RetentionField, RetentionProblem>> = {}
  for (const field of RETENTION_FIELDS) {
    const problem = retentionProblem(field, draft[field])
    if (problem !== null) found[field] = problem
  }
  return found
}

// The windows to send: only for a draft with no problem
export function retentionInputOf(draft: RetentionDraft): RetentionView {
  return {
    conversationDays: Number(draft.conversationDays.trim()),
    mediaDays: Number(draft.mediaDays.trim()),
    analyticsDays: Number(draft.analyticsDays.trim()),
    notificationDays: Number(draft.notificationDays.trim())
  }
}

// Compared as numbers: "0730" over 730 is not a change. A text that is not a number is a change, to be reported as a problem.
export function retentionChanged(saved: RetentionView, draft: RetentionDraft): boolean {
  return RETENTION_FIELDS.some(field => {
    const typed = draft[field].trim()
    return !WHOLE_NUMBER.test(typed) || Number(typed) !== saved[field]
  })
}

// The windows the draft makes shorter than the saved ones: the night after the save the run deletes what falls outside
export function shortenedFields(saved: RetentionView, draft: RetentionDraft): RetentionField[] {
  return RETENTION_FIELDS.filter(field => {
    if (retentionProblem(field, draft[field]) !== null) return false
    return Number(draft[field].trim()) < saved[field]
  })
}
