// What a routing rule does with a new conversation (TDD_10 §4): hand it to one person, to the least
// loaded of a list, or leave it for the team to take
export const RoutingActionTypes = {
  ASSIGN_USER: 'assign_user',
  ROUND_ROBIN: 'round_robin',
  UNASSIGNED: 'unassigned'
} as const
export type RoutingActionType = (typeof RoutingActionTypes)[keyof typeof RoutingActionTypes]

export const RoutingLimits = {
  // The rules of a store are read whole by the settings page and by every new conversation
  MAX_RULES_PER_STORE: 50,
  NAME_MAX_LENGTH: 100,
  MAX_CHANNEL_TYPES: 5,
  MAX_TAGS: 20,
  MAX_KEYWORDS: 20,
  KEYWORD_MAX_LENGTH: 64,
  MAX_USERS_PER_ACTION: 20,
  MIN_USERS_FOR_ROUND_ROBIN: 2,
  // The longest text of a first message that is searched for keywords
  KEYWORD_SEARCH_MAX_LENGTH: 4096
} as const
