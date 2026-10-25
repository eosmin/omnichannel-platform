import {
  checkExemptions,
  checkIsolationCoverage,
  planSteps,
  storeScopedModels,
  suiteResources
} from './isolation'

const schema = `
model Store {
  id String @id
  name String
}

model Conversation {
  id      String @id
  storeId String @map("store_id")
  @@map("conversations")
}

model ChannelConnection {
  id      String @id
  storeId String @map("store_id")
}

model Address {
  id         String @id
  customerId String @map("customer_id")
}
`

describe('storeScopedModels', () => {
  it('lists the models with a store_id column, sorted', () => {
    expect(storeScopedModels(schema)).toEqual(['ChannelConnection', 'Conversation'])
  })

  it('ignores a commented-out column and reads a column mapped with spaces', () => {
    const text = [
      'model Draft {',
      '  id String @id',
      '  // storeId String @map("store_id")',
      '}',
      'model Spaced {',
      '  id String @id',
      '  storeId String @map( "store_id" )',
      '}',
      'model Trailing {',
      '  id String @id',
      '  legacyId String // was @map("store_id")',
      '}',
      'model Slash {',
      '  id String @id',
      '  storeId String @default(dbgenerated("a/b")) @map("store_id")',
      '}'
    ].join('\n')
    expect(storeScopedModels(text)).toEqual(['Slash', 'Spaced'])
  })

  it('answers nothing for a schema with no store_id', () => {
    expect(storeScopedModels('model A {\n  id String @id\n}\n')).toEqual([])
  })
})

describe('suiteResources', () => {
  it('reads the names of the resources the suite loops over', () => {
    const suite = `const resources = [
      { name: 'conversation', create: createConversation },
      { name: 'channelConnection', create: createChannelConnection }
    ]`
    expect(suiteResources(suite)).toEqual(['channelConnection', 'conversation'])
  })

  it('does not take for a resource a body that happens to have a name', () => {
    const suite = `const resources = [
      {
        name: 'tag',
        create: createTag,
        modify: { path: id => id, body: { name: 'hacked' } }
      }
    ]`
    expect(suiteResources(suite)).toEqual(['tag'])
  })
})

describe('checkIsolationCoverage', () => {
  const models = ['ChannelConnection', 'Conversation', 'StoreSettings']

  it('passes when every model is covered or exempt', () => {
    expect(
      checkIsolationCoverage(models, ['channelConnection', 'conversation'], {
        StoreSettings: 'reached through its store'
      })
    ).toEqual({ uncovered: [], stale: [] })
  })

  it('lists the model that has no case in the suite and no reason', () => {
    expect(
      checkIsolationCoverage(models, ['conversation'], { StoreSettings: 'x' }).uncovered
    ).toEqual(['ChannelConnection'])
  })

  it('matches a model that starts with an acronym whatever the case of the resource', () => {
    expect(checkIsolationCoverage(['SMSLog', 'OAuthToken'], ['smsLog', 'oauthToken'], {})).toEqual({
      uncovered: [],
      stale: []
    })
  })

  it('does not take a property of Object for an exemption', () => {
    expect(checkIsolationCoverage(['toString'], [], {}).uncovered).toEqual(['toString'])
  })

  it('lists a model that is exempt and also has a case: the exemption is left over', () => {
    expect(
      checkIsolationCoverage(models, ['conversation', 'channelConnection', 'storeSettings'], {
        StoreSettings: 'x'
      }).stale
    ).toEqual(['StoreSettings'])
  })

  it('lists exemptions and resources that no longer match a model', () => {
    expect(
      checkIsolationCoverage(models, ['conversation', 'channelConnection', 'ghost'], {
        StoreSettings: 'x',
        Removed: 'x'
      }).stale
    ).toEqual(['Removed', 'ghost'])
  })
})

describe('planSteps', () => {
  const plan = [
    '## Progress tracking',
    '| Step | Name | Status | PR | Date |',
    '|---|---|---|---|---|',
    '| **Milestone 1: Auth and tenancy** | | | | |',
    '| 1.2 | Tenancy | done | #39 | 2026-10-25 |',
    '| 1.3 | Tenant isolation test suite | todo | | |',
    '| 5.5 | Onboarding | deferred (Phase 2) | | |',
    '| 2.2 | Customers | todo | | |'
  ].join('\n')

  it('reads the status of each step of the progress table', () => {
    expect(planSteps(plan)).toEqual(
      new Map([
        ['1.2', 'done'],
        ['1.3', 'todo'],
        ['5.5', 'deferred (Phase 2)'],
        ['2.2', 'todo']
      ])
    )
  })

  it('reads only the progress section: a table of steps elsewhere in the plan is not a status', () => {
    const withRuleset = [
      '## CI',
      '| 1.3 | `security-tests` job | none new |',
      '| 9.9 | a step that only the ruleset table mentions | none new |',
      plan
    ].join('\n')

    expect(planSteps(withRuleset).get('1.3')).toBe('todo')
    expect(planSteps(withRuleset).has('9.9')).toBe(false)
    expect(planSteps(withRuleset).size).toBe(4)
  })

  it('ignores the heading, the milestones and prose that mention a step', () => {
    expect(planSteps('Step 1.2 is done\n| not a row |\n| --- | --- |').size).toBe(0)
  })
})

describe('checkExemptions', () => {
  const steps = new Map([
    ['1.2', 'done'],
    ['2.2', 'todo']
  ])

  it('accepts an exemption for a step that is still to do', () => {
    expect(checkExemptions({ Customer: { reason: 'arrives later', step: '2.2' } }, steps)).toEqual({
      invalid: [],
      due: []
    })
  })

  it('lists the model whose step is done: its case has to be in the suite now', () => {
    expect(
      checkExemptions(
        {
          Tag: { reason: 'was a probe', step: '1.2' },
          Customer: { reason: 'arrives later', step: '2.2' }
        },
        steps
      )
    ).toEqual({ invalid: [], due: ['Tag'] })
  })

  it('refuses an exemption with no reason, or for a step the plan does not have', () => {
    expect(
      checkExemptions(
        {
          Blank: { reason: '   ', step: '2.2' },
          Typo: { reason: 'arrives later', step: '9.9' },
          Fine: { reason: 'arrives later', step: '2.2' }
        },
        steps
      )
    ).toEqual({ invalid: ['Blank', 'Typo'], due: [] })
  })
})
