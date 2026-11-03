import { RoutingActionTypes, RoutingLimits } from '@platform/core/domain'

import type { RuleView } from './routing-requests'
import {
  actionOf,
  channelChoicesOf,
  conditionsOf,
  draftOf,
  emptyDraft,
  inputOf,
  keywordsOf,
  ruleProblems,
  RuleProblems
} from './rule-form'

const rule: RuleView = {
  id: 'r1',
  name: 'VIP',
  priority: 0,
  enabled: false,
  conditions: { channelTypes: ['whatsapp'], tagIds: ['t1'], keywords: ['refund', 'late'] },
  action: { type: RoutingActionTypes.ROUND_ROBIN, userIds: ['u1', 'u2'] }
}

describe('keywordsOf', () => {
  it('drops blank lines and repeated words and trims each line', () => {
    expect(keywordsOf(' refund \n\n  \nlate\nrefund')).toEqual(['refund', 'late'])
  })
})

describe('draftOf and inputOf', () => {
  it('give back the rule that was opened', () => {
    expect(inputOf(draftOf(rule))).toEqual({
      name: 'VIP',
      enabled: false,
      conditions: rule.conditions,
      action: rule.action
    })
  })

  it('sends no condition that is empty, so a rule with none matches everything', () => {
    expect(conditionsOf({ ...emptyDraft(), name: 'All' })).toEqual({})
    expect(inputOf({ ...emptyDraft(), name: ' All ' })).toEqual({
      name: 'All',
      enabled: true,
      conditions: {},
      action: { type: RoutingActionTypes.UNASSIGNED }
    })
  })

  it('sends outsideBusinessHours only when it is on', () => {
    expect(conditionsOf({ ...emptyDraft(), outsideBusinessHours: true })).toEqual({
      outsideBusinessHours: true
    })
  })

  it('does not carry people to an action that takes none', () => {
    const draft = { ...emptyDraft(), actionType: RoutingActionTypes.UNASSIGNED, userIds: ['u1'] }
    expect(actionOf(draft)).toEqual({ type: RoutingActionTypes.UNASSIGNED })
  })
})

describe('ruleProblems', () => {
  const valid = { ...emptyDraft(), name: 'Rule' }

  it('accepts a rule with a name and no condition', () => {
    expect(ruleProblems(valid)).toEqual([])
  })

  it('asks for a name that fits', () => {
    expect(ruleProblems({ ...valid, name: '  ' })).toEqual([RuleProblems.NAME_REQUIRED])
    expect(ruleProblems({ ...valid, name: 'x'.repeat(RoutingLimits.NAME_MAX_LENGTH + 1) })).toEqual(
      [RuleProblems.NAME_TOO_LONG]
    )
  })

  it('asks for exactly one person to assign to', () => {
    const assign = { ...valid, actionType: RoutingActionTypes.ASSIGN_USER }
    expect(ruleProblems(assign)).toEqual([RuleProblems.ASSIGN_NEEDS_ONE])
    expect(ruleProblems({ ...assign, userIds: ['u1', 'u2'] })).toEqual([
      RuleProblems.ASSIGN_NEEDS_ONE
    ])
    expect(ruleProblems({ ...assign, userIds: ['u1'] })).toEqual([])
  })

  it('asks for at least two people for a round robin, and not too many', () => {
    const robin = { ...valid, actionType: RoutingActionTypes.ROUND_ROBIN, userIds: ['u1'] }
    expect(ruleProblems(robin)).toEqual([RuleProblems.ROUND_ROBIN_NEEDS_MANY])
    const many = Array.from({ length: RoutingLimits.MAX_USERS_PER_ACTION + 1 }, (_, i) => `u${i}`)
    expect(ruleProblems({ ...robin, userIds: many })).toEqual([RuleProblems.TOO_MANY_USERS])
    expect(ruleProblems({ ...robin, userIds: ['u1', 'u2'] })).toEqual([])
  })

  it('refuses a word that has no letter, digit or symbol to look for', () => {
    expect(ruleProblems({ ...valid, keywordsText: '\u200b' })).toEqual([RuleProblems.KEYWORD_EMPTY])
    expect(ruleProblems({ ...valid, keywordsText: 'hola' })).toEqual([])
  })

  it('holds keywords, tags and channels to the limits of the api', () => {
    const words = Array.from({ length: RoutingLimits.MAX_KEYWORDS + 1 }, (_, i) => `w${i}`).join(
      '\n'
    )
    expect(ruleProblems({ ...valid, keywordsText: words })).toEqual([
      RuleProblems.TOO_MANY_KEYWORDS
    ])
    expect(
      ruleProblems({ ...valid, keywordsText: 'x'.repeat(RoutingLimits.KEYWORD_MAX_LENGTH + 1) })
    ).toEqual([RuleProblems.KEYWORD_TOO_LONG])
    const tags = Array.from({ length: RoutingLimits.MAX_TAGS + 1 }, (_, i) => `t${i}`)
    expect(ruleProblems({ ...valid, tagIds: tags })).toEqual([RuleProblems.TOO_MANY_TAGS])
    const channels = Array.from({ length: RoutingLimits.MAX_CHANNEL_TYPES + 1 }, (_, i) => `c${i}`)
    expect(ruleProblems({ ...valid, channelTypes: channels })).toEqual([
      RuleProblems.TOO_MANY_CHANNELS
    ])
  })
})

describe('channelChoicesOf', () => {
  const entry = (pluginId: string, status: string, pluginName = pluginId) => ({
    id: `c-${pluginId}-${status}`,
    pluginId,
    pluginName,
    displayName: pluginName,
    status,
    capabilities: []
  })

  it('offers each channel of the store once, however many accounts it has', () => {
    const directory = [
      entry('whatsapp', 'active'),
      entry('whatsapp', 'active'),
      entry('web_widget', 'active')
    ]

    expect(channelChoicesOf(directory, []).map(choice => choice.id)).toEqual([
      'whatsapp',
      'web_widget'
    ])
  })

  it('leaves out a channel whose accounts are all disconnected, and keeps one that has a live account', () => {
    const directory = [
      entry('messenger', 'disconnected'),
      entry('whatsapp', 'disconnected'),
      entry('whatsapp', 'active')
    ]

    expect(channelChoicesOf(directory, []).map(choice => choice.id)).toEqual(['whatsapp'])
  })

  it('keeps a channel the rule already names, so that it can be taken out', () => {
    const directory = [entry('whatsapp', 'active')]

    expect(channelChoicesOf(directory, ['instagram']).map(choice => choice.id)).toEqual([
      'whatsapp',
      'instagram'
    ])
  })

  it('does not repeat a channel the rule names and the store has', () => {
    const directory = [entry('whatsapp', 'active')]

    expect(channelChoicesOf(directory, ['whatsapp'])).toHaveLength(1)
  })

  it('carries the name the plugin gave itself, for a channel that is not an official one', () => {
    const directory = [entry('acme_chat', 'active', 'Acme Chat')]

    expect(channelChoicesOf(directory, [])).toEqual([{ id: 'acme_chat', name: 'Acme Chat' }])
  })
})
