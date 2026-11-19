// Marks a handler of a domain event that needs no tenant context of its own (RLS phase 6), and says why. It does nothing at runtime:
// the static spec of the listeners (listeners-event-context.spec.ts) reads it as the alternative to @InEventStore / @InEventOrganization.
// Legitimate reasons: the handler only publishes to a socket room or drops a Redis key and reads no table, or it opens the context
// itself in its body for part of its work (`this.events.inStore(...)`). A handler that reads or writes a table without either does not
// belong here: wrap it. The reason is mandatory so that each exemption can be reviewed.
export function EventContextNotNeeded(reason: string) {
  if (reason.trim() === '') {
    throw new Error('EventContextNotNeeded needs a reason')
  }
  return <F extends (payload: never) => unknown>(
    _target: object,
    _key: string | symbol,
    _descriptor: TypedPropertyDescriptor<F>
  ): void => undefined
}
