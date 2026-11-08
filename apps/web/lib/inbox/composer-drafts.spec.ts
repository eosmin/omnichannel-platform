import {
  clearComposerDrafts,
  DRAFT_MAX_AGE_MS,
  draftKey,
  readDraft,
  writeDraft,
  type DraftScope
} from './composer-drafts'

class MemoryStorage {
  private readonly items = new Map<string, string>()
  get length(): number {
    return this.items.size
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }
  removeItem(key: string): void {
    this.items.delete(key)
  }
}

const scope: DraftScope = { userId: 'u1', storeId: 's1', conversationId: 'c1' }

describe('composer drafts', () => {
  it('gives back what was written for the same person, store and conversation', () => {
    const storage = new MemoryStorage()
    writeDraft(storage, scope, { text: 'hello', isNote: false, mentions: [] })

    expect(readDraft(storage, scope)).toEqual({ text: 'hello', isNote: false, mentions: [] })
  })

  it('keeps a note a note', () => {
    const storage = new MemoryStorage()
    writeDraft(storage, scope, { text: 'call back', isNote: true, mentions: [] })

    expect(readDraft(storage, scope)?.isNote).toBe(true)
  })

  it('does not hand a draft to another person, store or conversation', () => {
    const storage = new MemoryStorage()
    writeDraft(storage, scope, { text: 'private', isNote: false, mentions: [] })

    expect(readDraft(storage, { ...scope, userId: 'u2' })).toBeNull()
    expect(readDraft(storage, { ...scope, storeId: 's2' })).toBeNull()
    expect(readDraft(storage, { ...scope, conversationId: 'c2' })).toBeNull()
  })

  it('removes the draft when the text is emptied or only blanks', () => {
    const storage = new MemoryStorage()
    writeDraft(storage, scope, { text: 'hello', isNote: false, mentions: [] })
    writeDraft(storage, scope, { text: '  \n', isNote: false, mentions: [] })

    expect(storage.getItem(draftKey(scope))).toBeNull()
  })

  it('ignores what is stored when it is not a draft', () => {
    const storage = new MemoryStorage()
    storage.setItem(draftKey(scope), 'not json')
    expect(readDraft(storage, scope)).toBeNull()
    storage.setItem(draftKey(scope), JSON.stringify({ text: 5 }))
    expect(readDraft(storage, scope)).toBeNull()
  })

  it('keeps the people a note named', () => {
    const storage = new MemoryStorage()
    const mentions = [{ id: 'm1', name: 'Ana' }]
    writeDraft(storage, scope, { text: '@Ana call', isNote: true, mentions })

    expect(readDraft(storage, scope)?.mentions).toEqual(mentions)
  })

  it('drops a draft older than its life and removes it', () => {
    const storage = new MemoryStorage()
    writeDraft(storage, scope, { text: 'old', isNote: false, mentions: [] }, 1000)

    expect(readDraft(storage, scope, 1000 + DRAFT_MAX_AGE_MS)).not.toBeNull()
    expect(readDraft(storage, scope, 1001 + DRAFT_MAX_AGE_MS)).toBeNull()
    expect(storage.getItem(draftKey(scope))).toBeNull()
  })

  it('survives a storage that throws', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      }
    }

    expect(readDraft(blocked, scope)).toBeNull()
    expect(() =>
      writeDraft(blocked, scope, { text: 'x', isNote: false, mentions: [] })
    ).not.toThrow()
  })

  it('ignores a draft saved before drafts carried a time', () => {
    const storage = new MemoryStorage()
    storage.setItem(draftKey(scope), JSON.stringify({ text: 'old', isNote: false }))

    expect(readDraft(storage, scope)).toBeNull()
  })

  it('clears without throwing when the storage is blocked', () => {
    const blocked = {
      length: 1,
      key: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      }
    }

    expect(() => clearComposerDrafts(blocked)).not.toThrow()
  })

  it('clears every draft and nothing else when the session ends', () => {
    const storage = new MemoryStorage()
    writeDraft(storage, scope, { text: 'one', isNote: false, mentions: [] })
    writeDraft(storage, { ...scope, userId: 'u2' }, { text: 'two', isNote: false, mentions: [] })
    storage.setItem('other', 'kept')

    clearComposerDrafts(storage)

    expect(readDraft(storage, scope)).toBeNull()
    expect(storage.getItem('other')).toBe('kept')
    expect(storage.length).toBe(1)
  })

  it('says whether the storage kept the draft, so that nothing shows one that is not there', () => {
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => undefined
    }

    expect(writeDraft(refusing, scope, { text: 'Hi', isNote: false, mentions: [] })).toBe(false)
    expect(
      writeDraft(new MemoryStorage(), scope, { text: 'Hi', isNote: false, mentions: [] })
    ).toBe(true)
  })
})
