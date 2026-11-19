// Marks a handler of a domain event that needs no tenant context of its own (RLS phase 6), and says why. It does nothing at runtime:
// the static spec of the listeners (listeners-event-context.spec.ts) reads it as the alternative to @InEventStore / @InEventOrganization.
// The legitimate reason: the handler reads no table (it only publishes to a socket room or drops a Redis key), or its only read is
// made by another object that opens a context of its own, which the reason names. A handler that opens its context in its body does not
// need the marker, and one that reads a table without a context does not belong here: wrap it. The reason is mandatory so that each exemption can be reviewed.
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
