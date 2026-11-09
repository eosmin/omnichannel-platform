import {
  ALLOWED_FILES,
  baselineGrowth,
  checkAgainstBaseline,
  countReferences,
  isScanned,
  lowerBaseline
} from './channel-agnostic'

describe('isScanned', () => {
  it('scans production code outside the channel plugins', () => {
    for (const file of [
      'apps/web/components/inbox/message-bubble.tsx',
      'apps/api/src/messages/messages.service.ts',
      'apps/worker/src/outbound/outbound-sender.ts',
      'libs/core/domain/channel-ids.ts',
      'libs/plugins/sdk/src/channel-plugin.ts',
      'libs/plugins/runtime/src/registry.ts',
      'libs/api-client/src/query-keys.ts'
    ]) {
      expect(isScanned(file)).toBe(true)
    }
  })

  it('leaves out the plugins, tests, e2e, migrations, fixtures and what is not source', () => {
    for (const file of [
      'libs/channels/whatsapp/src/plugin.ts',
      'apps/api/src/messages/messages.service.spec.ts',
      'apps/web/components/x.test.tsx',
      'apps/web-e2e/specs/inbox.spec.ts',
      'apps/api/tests/helpers.ts',
      'tests/security/tenant-isolation.spec.ts',
      'libs/core/database/prisma/migrations/20261101_x/migration.sql',
      'libs/core/database/rollbacks/20261101_x.rollback.sql',
      'libs/core/database/prisma/dev-fixtures.ts',
      'libs/core/database/src/dev-fixtures.ts',
      'apps/web/messages/es.json',
      'apps/web/README.md',
      'scripts/lib/channel-agnostic.ts',
      'docs/TDD_10.md'
    ]) {
      expect(isScanned(file)).toBe(false)
    }
  })

  it('leaves out a composition root that has its reason written', () => {
    expect(Object.keys(ALLOWED_FILES)).toContain('libs/plugins/runtime/src/official-plugins.ts')
    // Adding a file here is a decision to review: it has to change this list too
    expect(Object.keys(ALLOWED_FILES)).toEqual(['libs/plugins/runtime/src/official-plugins.ts'])
    for (const reason of Object.values(ALLOWED_FILES)) expect(reason.length).toBeGreaterThan(20)
    expect(isScanned('libs/plugins/runtime/src/official-plugins.ts')).toBe(false)
  })
})

describe('countReferences', () => {
  it('counts the lines that name a channel or Meta, whatever the case', () => {
    const source = [
      "const id = 'whatsapp'",
      'const ok = 1',
      'import { x } from "graph.facebook.com"',
      'ChannelIds.INSTAGRAM',
      'const wamid = "x"',
      'const url = "https://scontent.cdninstagram.com/a"',
      'class MessengerMedia {}',
      'const a = payload.wa_id + phone_number_id',
      'const host = "x.fbcdn.net"',
      'const t = new MetaLogin()'
    ].join('\n')
    expect(countReferences(source)).toEqual({ code: 9, comment: 0 })
  })

  it('counts a line once however many names it holds', () => {
    expect(countReferences('whatsapp instagram messenger')).toEqual({ code: 1, comment: 0 })
  })

  it('does not match words that only contain "meta"', () => {
    expect(
      countReferences(
        'metadata, metaphor, parameter, Metal, Metadata, import.meta.url, r.meta.total'
      )
    ).toEqual({
      code: 0,
      comment: 0
    })
  })

  it('counts a bare "meta" word and the Meta[A-Z] forms', () => {
    expect(countReferences('// Meta sends it\nconst x = MetaMessaging.Url')).toEqual({
      code: 1,
      comment: 1
    })
  })

  it('tells comments (line, block and JSDoc) from code', () => {
    const source = [
      '// whatsapp line comment',
      '/* instagram',
      ' * messenger inside a block',
      ' */',
      '/** facebook */',
      'const x = 1 // whatsapp trailing counts as code',
      "const url = 'https://graph.facebook.com'"
    ].join('\n')
    expect(countReferences(source)).toEqual({ code: 2, comment: 4 })
  })
})

describe('checkAgainstBaseline', () => {
  const baseline = {
    'apps/web/a.ts': { code: 3, comment: 1 },
    'apps/web/b.ts': { code: 1, comment: 0 }
  }

  it('passes when nothing changed', () => {
    expect(checkAgainstBaseline(baseline, { ...baseline })).toEqual([])
  })

  it('fails on a file without an entry that gains a reference', () => {
    const found = checkAgainstBaseline(baseline, {
      ...baseline,
      'apps/api/new.ts': { code: 0, comment: 1 }
    })
    expect(found).toEqual([expect.objectContaining({ file: 'apps/api/new.ts', kind: 'new' })])
  })

  it('fails when code or comments grow over the entry', () => {
    const found = checkAgainstBaseline(baseline, {
      ...baseline,
      'apps/web/a.ts': { code: 3, comment: 2 }
    })
    expect(found).toEqual([expect.objectContaining({ file: 'apps/web/a.ts', kind: 'grew' })])
  })

  it('fails on a stale entry, a file that shrank, vanished or has no match left', () => {
    const found = checkAgainstBaseline(baseline, { 'apps/web/a.ts': { code: 2, comment: 1 } })
    expect(found.map(({ file, kind }) => [file, kind])).toEqual([
      ['apps/web/a.ts', 'stale'],
      ['apps/web/b.ts', 'stale']
    ])
  })

  it('fails on an entry of zero', () => {
    const zero = { 'a.ts': { code: 0, comment: 0 } }
    expect(checkAgainstBaseline(zero, {})).toEqual([expect.objectContaining({ kind: 'stale' })])
  })
})

describe('lowerBaseline', () => {
  it('shrinks the entries, drops the ones at zero and keeps the keys sorted', () => {
    const next = lowerBaseline(
      {
        'b.ts': { code: 3, comment: 1 },
        'a.ts': { code: 1, comment: 1 },
        'c.ts': { code: 1, comment: 0 }
      },
      { 'b.ts': { code: 2, comment: 0 }, 'a.ts': { code: 1, comment: 1 } }
    )
    expect(Object.keys(next)).toEqual(['a.ts', 'b.ts'])
    expect(next['b.ts']).toEqual({ code: 2, comment: 0 })
  })

  it('refuses to add or raise an entry', () => {
    const one = { 'a.ts': { code: 1, comment: 0 } }
    expect(() => lowerBaseline(one, { 'a.ts': { code: 1, comment: 1 } })).toThrow(/a\.ts/)
    expect(() => lowerBaseline(one, { ...one, 'c.ts': { code: 1, comment: 0 } })).toThrow(/c\.ts/)
  })
})

describe('baselineGrowth', () => {
  it('reports an entry added or raised against the baseline of main', () => {
    expect(
      baselineGrowth(
        { 'a.ts': { code: 1, comment: 0 } },
        { 'a.ts': { code: 1, comment: 1 }, 'b.ts': { code: 1, comment: 0 } }
      )
    ).toEqual(['a.ts', 'b.ts'])
  })

  it('accepts a baseline that only shrinks', () => {
    expect(
      baselineGrowth({ 'a.ts': { code: 2, comment: 1 } }, { 'a.ts': { code: 1, comment: 1 } })
    ).toEqual([])
  })
})
