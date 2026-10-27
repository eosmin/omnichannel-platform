// A socket that stops heartbeating is not online after SOCKET_TTL_SECONDS. The client sends a heartbeat
// every 30 s (Step 3.1), so one lost heartbeat does not take a user offline.
export const PresenceTiming = {
  SOCKET_TTL_SECONDS: 60,
  AWAY_AFTER_SECONDS: 300,
  // A last-activity mark nobody refreshes is dropped after a day
  ACTIVITY_TTL_SECONDS: 86_400
} as const
