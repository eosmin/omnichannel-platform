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

  it('lists exemptions and resources that no longer match a model', () => {
    expect(
      checkIsolationCoverage(models, ['conversation', 'channelConnection', 'ghost'], {
        StoreSettings: 'x',
        Removed: 'x'
      }).stale
    ).toEqual(['Removed', 'ghost'])
  })
})
