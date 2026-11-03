import type { ChannelDirectoryEntryView } from '@platform/api-client'
import {
  ChannelConnectionStatus,
  plainText,
  RoutingActionTypes,
  RoutingLimits
} from '@platform/core/domain'

import type { RuleAction, RuleConditions, RuleInput, RuleView } from './routing-requests'

// The form of a routing rule (TDD_09 §13), as plain values, and the checks done before the request.
// The api checks the same and more (a tag or a person of another store is a 404 there).

export type ActionType = (typeof RoutingActionTypes)[keyof typeof RoutingActionTypes]

export interface RuleDraft {
  name: string
  enabled: boolean
  channelTypes: string[]
  tagIds: string[]
  // One word or phrase per line
  keywordsText: string
  outsideBusinessHours: boolean
  actionType: ActionType
  userIds: string[]
}

export const RuleProblems = {
  NAME_REQUIRED: 'nameRequired',
  NAME_TOO_LONG: 'nameTooLong',
  TOO_MANY_CHANNELS: 'tooManyChannels',
  TOO_MANY_TAGS: 'tooManyTags',
  TOO_MANY_KEYWORDS: 'tooManyKeywords',
  KEYWORD_TOO_LONG: 'keywordTooLong',
  KEYWORD_EMPTY: 'keywordEmpty',
  ASSIGN_NEEDS_ONE: 'assignNeedsOne',
  ROUND_ROBIN_NEEDS_MANY: 'roundRobinNeedsMany',
  TOO_MANY_USERS: 'tooManyUsers'
} as const
export type RuleProblem = (typeof RuleProblems)[keyof typeof RuleProblems]

export function emptyDraft(): RuleDraft {
  return {
    name: '',
    enabled: true,
    channelTypes: [],
    tagIds: [],
    keywordsText: '',
    outsideBusinessHours: false,
    actionType: RoutingActionTypes.UNASSIGNED,
    userIds: []
  }
}

export function draftOf(rule: RuleView): RuleDraft {
  return {
    name: rule.name,
    enabled: rule.enabled,
    channelTypes: rule.conditions.channelTypes ?? [],
    tagIds: rule.conditions.tagIds ?? [],
    keywordsText: (rule.conditions.keywords ?? []).join('\n'),
    outsideBusinessHours: rule.conditions.outsideBusinessHours === true,
    actionType: rule.action.type,
    userIds: rule.action.type === RoutingActionTypes.UNASSIGNED ? [] : rule.action.userIds
  }
}

// Blank lines go, and a word written twice is one word
export function keywordsOf(text: string): string[] {
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const word = line.trim()
    if (word !== '') seen.add(word)
  }
  return [...seen]
}

export function ruleProblems(draft: RuleDraft): RuleProblem[] {
  const problems: RuleProblem[] = []
  const name = draft.name.trim()
  if (name === '') problems.push(RuleProblems.NAME_REQUIRED)
  else if (name.length > RoutingLimits.NAME_MAX_LENGTH) problems.push(RuleProblems.NAME_TOO_LONG)
  if (draft.channelTypes.length > RoutingLimits.MAX_CHANNEL_TYPES) {
    problems.push(RuleProblems.TOO_MANY_CHANNELS)
  }
  if (draft.tagIds.length > RoutingLimits.MAX_TAGS) problems.push(RuleProblems.TOO_MANY_TAGS)
  const keywords = keywordsOf(draft.keywordsText)
  if (keywords.length > RoutingLimits.MAX_KEYWORDS) problems.push(RuleProblems.TOO_MANY_KEYWORDS)
  if (keywords.some(word => word.length > RoutingLimits.KEYWORD_MAX_LENGTH)) {
    problems.push(RuleProblems.KEYWORD_TOO_LONG)
  }
  // The api compares a word as plain text, and a word with nothing left is found in every message
  if (keywords.some(word => plainText(word) === '')) problems.push(RuleProblems.KEYWORD_EMPTY)
  if (draft.actionType === RoutingActionTypes.ASSIGN_USER && draft.userIds.length !== 1) {
    problems.push(RuleProblems.ASSIGN_NEEDS_ONE)
  }
  if (draft.actionType === RoutingActionTypes.ROUND_ROBIN) {
    if (draft.userIds.length < RoutingLimits.MIN_USERS_FOR_ROUND_ROBIN) {
      problems.push(RuleProblems.ROUND_ROBIN_NEEDS_MANY)
    } else if (draft.userIds.length > RoutingLimits.MAX_USERS_PER_ACTION) {
      problems.push(RuleProblems.TOO_MANY_USERS)
    }
  }
  return problems
}

// A condition left empty is not sent: a rule with none matches every conversation. Only the four
// fields of a rule are built here, so nothing else the form might hold reaches the request.
export function conditionsOf(draft: RuleDraft): RuleConditions {
  const conditions: RuleConditions = {}
  if (draft.channelTypes.length > 0) conditions.channelTypes = draft.channelTypes
  if (draft.tagIds.length > 0) conditions.tagIds = draft.tagIds
  const keywords = keywordsOf(draft.keywordsText)
  if (keywords.length > 0) conditions.keywords = keywords
  if (draft.outsideBusinessHours) conditions.outsideBusinessHours = true
  return conditions
}

export function actionOf(draft: RuleDraft): RuleAction {
  return draft.actionType === RoutingActionTypes.UNASSIGNED
    ? { type: RoutingActionTypes.UNASSIGNED }
    : { type: draft.actionType, userIds: draft.userIds }
}

export function inputOf(draft: RuleDraft): RuleInput {
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    conditions: conditionsOf(draft),
    action: actionOf(draft)
  }
}

// A channel a rule can name: its id, and the name its plugin gave itself (drawn only for a channel
// that is not an official one, which has its own translated name)
export interface ChannelChoice {
  id: string
  name: string
}

// The channels the store has a live account on, once each, plus those the rule already names (a
// channel since disconnected stays in the rule until it is saved again, and must be removable).
export function channelChoicesOf(
  directory: readonly ChannelDirectoryEntryView[],
  selected: readonly string[]
): ChannelChoice[] {
  const choices = new Map<string, ChannelChoice>()
  for (const entry of directory) {
    if (entry.status === String(ChannelConnectionStatus.DISCONNECTED)) continue
    if (!choices.has(entry.pluginId)) {
      choices.set(entry.pluginId, { id: entry.pluginId, name: entry.pluginName })
    }
  }
  for (const id of selected) {
    if (!choices.has(id)) choices.set(id, { id, name: id })
  }
  return [...choices.values()]
}
