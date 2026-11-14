import { RetentionBounds } from '@platform/core/domain'

import {
  retentionChanged,
  retentionDraftOf,
  retentionInputOf,
  retentionProblem,
  retentionProblems,
  shortenedFields
} from './retention-form'

const saved = { conversationDays: 365, mediaDays: 365, analyticsDays: 395, notificationDays: 90 }

describe('retention form', () => {
  it('starts from the saved windows, as text', () => {
    expect(retentionDraftOf(saved)).toEqual({
      conversationDays: '365',
      mediaDays: '365',
      analyticsDays: '395',
      notificationDays: '90'
    })
  })

  it('accepts the floor and the ceiling of each window and refuses what is past them', () => {
    for (const [field, { min, max }] of Object.entries(RetentionBounds)) {
      const key = field as keyof typeof RetentionBounds
      expect(retentionProblem(key, String(min))).toBeNull()
      expect(retentionProblem(key, String(max))).toBeNull()
      expect(retentionProblem(key, String(min - 1))).toBe('tooLow')
      expect(retentionProblem(key, String(max + 1))).toBe('tooHigh')
    }
  })

  it('refuses an empty box and anything that is not a whole number of days', () => {
    expect(retentionProblem('mediaDays', '')).toBe('required')
    expect(retentionProblem('mediaDays', '  ')).toBe('required')
    for (const text of ['30.5', '-40', '1e3', '0x40', '4 0', 'abc', '+60']) {
      expect(retentionProblem('mediaDays', text)).toBe('whole')
    }
    expect(retentionProblem('mediaDays', ' 60 ')).toBeNull()
  })

  it('names each field with a problem, and none when the draft is good', () => {
    expect(retentionProblems(retentionDraftOf(saved))).toEqual({})
    expect(
      retentionProblems({ ...retentionDraftOf(saved), notificationDays: '3', mediaDays: '' })
    ).toEqual({ notificationDays: 'tooLow', mediaDays: 'required' })
  })

  it('turns a good draft into the four numbers to send', () => {
    expect(retentionInputOf({ ...retentionDraftOf(saved), mediaDays: ' 60 ' })).toEqual({
      ...saved,
      mediaDays: 60
    })
  })

  it('tells a change from a draft that only has other spaces', () => {
    expect(retentionChanged(saved, retentionDraftOf(saved))).toBe(false)
    expect(retentionChanged(saved, { ...retentionDraftOf(saved), mediaDays: ' 365 ' })).toBe(false)
    expect(retentionChanged(saved, { ...retentionDraftOf(saved), mediaDays: '366' })).toBe(true)
    // The same number with zeros in front is not a change; an empty box is
    expect(retentionChanged(saved, { ...retentionDraftOf(saved), mediaDays: '0365' })).toBe(false)
    expect(retentionChanged(saved, { ...retentionDraftOf(saved), mediaDays: '' })).toBe(true)
  })

  it('warns only for the windows made shorter by a good number', () => {
    const draft = {
      conversationDays: '200',
      mediaDays: '400',
      analyticsDays: '10',
      notificationDays: '90'
    }
    // analyticsDays: 10 is below its floor, so it is a problem to fix and not a deletion to warn about
    expect(shortenedFields(saved, draft)).toEqual(['conversationDays'])
  })
})
