// The days a person picks ('YYYY-MM-DD', in the zone of the browser) as the moments the api filters by: the start of the first
// day and the last millisecond of the second. A day left empty leaves that side open.
export function dayRangeToMoments(
  from: string,
  to: string
): { from: string | undefined; to: string | undefined } {
  const start = from === '' ? undefined : new Date(`${from}T00:00:00`)
  const end = to === '' ? undefined : new Date(`${to}T23:59:59.999`)
  return {
    from: start === undefined || Number.isNaN(start.getTime()) ? undefined : start.toISOString(),
    to: end === undefined || Number.isNaN(end.getTime()) ? undefined : end.toISOString()
  }
}
