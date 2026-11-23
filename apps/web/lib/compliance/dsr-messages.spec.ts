import {
  DsrLegalBaseCodes,
  DsrNoticeStatuses,
  DsrReviewCodes,
  DSR_SUMMARY_COUNT_ORDER,
  DsrStatus,
  DsrType
} from '@platform/core/domain'

import en from '../../messages/en.json'
import es from '../../messages/es.json'

// A value the api can send with no words for it would draw "unknown" in front of a reviewer: every one has its text, in both languages.
describe.each([
  ['en', en.settings.dataRequests],
  ['es', es.settings.dataRequests]
])('the texts of the data requests in %s', (_language, messages) => {
  const keysOf = (group: Record<string, unknown>): string[] => Object.keys(group).sort()

  it('has a text for every type and every status', () => {
    expect(keysOf(messages.types)).toEqual([...Object.values(DsrType), 'unknown'].sort())
    expect(keysOf(messages.statuses)).toEqual([...Object.values(DsrStatus), 'unknown'].sort())
  })

  it('has a text for every code, every notice state and every legal basis', () => {
    expect(keysOf(messages.failure.codes)).toEqual(
      [...Object.values(DsrReviewCodes), 'unknown'].sort()
    )
    expect(keysOf(messages.notice.statuses)).toEqual(
      [...Object.values(DsrNoticeStatuses), 'unknown'].sort()
    )
    expect(keysOf(messages.summary.bases)).toEqual(
      [...Object.values(DsrLegalBaseCodes), 'unknown'].sort()
    )
  })

  it('has a text for every count a summary can carry', () => {
    expect(keysOf(messages.summary.counts)).toEqual([...DSR_SUMMARY_COUNT_ORDER].sort())
  })

  it('has the three decisions, each with what it does and what confirms it', () => {
    for (const kind of ['approveErasure', 'approveExport', 'reject', 'cancel'] as const) {
      const block = messages.decision[kind]
      expect(Object.keys(block.effects).length).toBeGreaterThan(0)
      for (const key of [
        'title',
        'submit',
        'confirm',
        'confirmTitle',
        'confirmDescription',
        'done'
      ]) {
        expect(block).toHaveProperty(key)
      }
    }
  })

  it('never states as a fact that the person was not told, under any key of a notice', () => {
    expect(noticeTextsOf(messages).length).toBeGreaterThan(12)
    expect(wordedAsCertain(messages)).toEqual([])
  })
})

// The server does not know that the person never got the mail (`mail_lost` was accepted by the queue and may have arrived): no text of a
// notice that failed may say so as a fact. Checked by PREFIX over every leaf, so a key added later is held too, not only the ones listed.
const CERTAIN =
  /nunca|jam[áa]s|never|no recibi[óo]|no supo|did not receive|didn't receive|did not know|sin avisar|not notified/i
const NOTICE_PREFIXES = [
  /^banners\.noticeFailed\./,
  /^marks\.noticeFailed$/,
  /^notice\./,
  /^failure\.codes\.(mail_[a-z]+|address_unreadable)$/
]

function leavesOf(node: unknown, path = ''): { path: string; text: string }[] {
  if (typeof node === 'string') return [{ path, text: node }]
  if (node === null || typeof node !== 'object') return []
  return Object.entries(node).flatMap(([key, value]) =>
    leavesOf(value, path === '' ? key : `${path}.${key}`)
  )
}

function noticeTextsOf(tree: unknown): { path: string; text: string }[] {
  return leavesOf(tree).filter(leaf => NOTICE_PREFIXES.some(prefix => prefix.test(leaf.path)))
}

function wordedAsCertain(tree: unknown): string[] {
  return noticeTextsOf(tree)
    .filter(leaf => CERTAIN.test(leaf.text))
    .map(leaf => leaf.path)
}

describe('the check of the texts of a notice', () => {
  it('catches a certain statement under each prefix, in either language, so it dies if the check is loosened', () => {
    const planted = {
      banners: { noticeFailed: { extra: 'La persona nunca lo supo' } },
      marks: { noticeFailed: 'Never told' },
      notice: { newKey: { deep: 'No supo nada' }, statuses: { other: 'Jamás llegó' } },
      failure: {
        codes: {
          mail_new: 'The person did not receive it',
          address_unreadable: 'No recibió el aviso',
          attempts_exhausted: 'nunca (outside the prefixes, allowed)'
        }
      }
    }
    expect(wordedAsCertain(planted).sort()).toEqual([
      'banners.noticeFailed.extra',
      'failure.codes.address_unreadable',
      'failure.codes.mail_new',
      'marks.noticeFailed',
      'notice.newKey.deep',
      'notice.statuses.other'
    ])
  })
})
