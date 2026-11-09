import { isSameReplyTarget } from './reply-target-match'

describe('isSameReplyTarget', () => {
  it('is the same only for the same message AND the same file', () => {
    expect(isSameReplyTarget({ messageId: 'm', mediaId: 'f2' }, 'm', 'f2')).toBe(true)
    expect(isSameReplyTarget({ messageId: 'm' }, 'm', undefined)).toBe(true)
    // A newer quote of another file of the same message is not the one a send took: it is kept
    expect(isSameReplyTarget({ messageId: 'm', mediaId: 'f3' }, 'm', 'f2')).toBe(false)
    expect(isSameReplyTarget({ messageId: 'm' }, 'm', 'f2')).toBe(false)
    expect(isSameReplyTarget({ messageId: 'x', mediaId: 'f2' }, 'm', 'f2')).toBe(false)
    expect(isSameReplyTarget(null, 'm', undefined)).toBe(false)
  })
})
