import { CustomerProfileFetch, DAY_MS, HOUR_MS, isPlainHttpsUrl } from '@platform/core/domain'

export interface ProfileState {
  profileFetchedAt: Date | null
  profileRetryAfter: Date | null
}

// A profile never read, or read longer ago than the photo link of a channel lasts, is read again
export function isProfileStale(profileFetchedAt: Date | null, now: Date): boolean {
  if (profileFetchedAt === null) return true
  return (
    now.getTime() - profileFetchedAt.getTime() >= CustomerProfileFetch.STALE_AFTER_DAYS * DAY_MS
  )
}

// Stale, and not waiting out the pause that follows an outage
export function needsProfileRead(state: ProfileState, now: Date): boolean {
  if (state.profileRetryAfter !== null && state.profileRetryAfter.getTime() > now.getTime()) {
    return false
  }
  return isProfileStale(state.profileFetchedAt, now)
}

// When an outage lets the profile be asked for again
export function retryAfterOutage(now: Date): Date {
  return new Date(now.getTime() + CustomerProfileFetch.RETRY_AFTER_HOURS * HOUR_MS)
}

// One job for each state of the profile and each day: a message that arrives while the job waits adds
// nothing, a read that settled (a new stamp) lets the next stale one in, and the day keeps the jobs that
// BullMQ retains from blocking the read for good
export function profileJobId(identityId: string, state: ProfileState, now: Date): string {
  const stamps = [state.profileFetchedAt, state.profileRetryAfter].map(date => date?.getTime() ?? 0)
  return [
    CustomerProfileFetch.JOB_ID_PREFIX,
    identityId,
    ...stamps,
    Math.floor(now.getTime() / DAY_MS)
  ].join('-')
}

// A plugin may be a third party's: the link it hands over is kept only if it is a plain https url
export function plainHttpsUrl(value: string | undefined, maxLength: number): string | undefined {
  return value !== undefined && value.length <= maxLength && isPlainHttpsUrl(value)
    ? value
    : undefined
}
