import { checkIsolationCoverage, storeScopedModels, suiteResources } from './isolation'

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

  it('lists exemptions and resources that no longer match a model', () => {
    expect(
      checkIsolationCoverage(models, ['conversation', 'channelConnection', 'ghost'], {
        StoreSettings: 'x',
        Removed: 'x'
      }).stale
    ).toEqual(['Removed', 'ghost'])
  })
})
