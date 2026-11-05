// Whether the payload of a `notification` event asks for the sound. The server already left it false
// during the quiet hours of the person (notification-preferences.service.ts)
export function wantsSound(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { sound?: unknown }).sound === true
  )
}
