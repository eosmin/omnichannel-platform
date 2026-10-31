// How long typing signals last. The browser sends and draws them; the api only relays them.
export const TypingTiming = {
  // An agent who keeps typing repeats the start at this gap, so the others' "is typing" does not lapse
  AGENT_START_GAP_MS: 3_000,
  // An agent who stopped writing for this long has stopped typing, though the text is still in the box
  AGENT_IDLE_STOP_MS: 5_000,
  // The visitor's widget sends one signal in 2 s at most and Meta sends none, so a customer who has not
  // signalled in this long is no longer typing
  CUSTOMER_LAPSE_MS: 5_000,
  // A teammate's start with no stop (a closed laptop) lapses by itself, as the widget's does
  TEAMMATE_LAPSE_MS: 25_000
} as const
