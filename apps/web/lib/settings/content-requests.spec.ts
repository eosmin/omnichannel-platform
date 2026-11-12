import { ApiError, createApiClient } from '@platform/api-client'

import {
  fetchInboxSettings,
  fetchPreferences,
  saveInboxSettings,
  savePreferences
} from './inbox-requests'
import {
  createStoreSnippet,
  deleteStoreSnippet,
  fetchStoreSnippets,
  updateStoreSnippet
} from './snippets-requests'
import { createStoreTag, deleteStoreTag, fetchStoreTags, updateStoreTag } from './tags-requests'

function setup(body: unknown, status = 200) {
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>().mockImplementation(() =>
    Promise.resolve(
      status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' }
          })
    )
  )
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  const call = () => fetchImpl.mock.calls[0] ?? []
  return { client, call }
}

function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
}

const tag = { id: 't1', name: 'VIP', color: '#aabbcc', description: null }
const snippet = {
  id: 's1',
  shortcut: 'gracias',
  title: 'Thanks',
  content: 'Gracias!',
  updatedAt: '2026-11-03T10:00:00.000Z'
}
const inbox = {
  reopenWindowDays: null,
  autoArchiveAfterDays: 30,
  resolveShowOptions: true,
  sendClosingMessage: false,
  closingSnippetId: null,
  requestCsat: false,
  agentLoadThreshold: 8
}

describe('tag requests', () => {
  it('reads the list under the store', async () => {
    const { client, call } = setup([tag])
    await expect(fetchStoreTags(client, 's-1')).resolves.toEqual([tag])
    expect(call()[0]).toBe('https://api.example.com/api/v1/settings/tags')
    expect(new Headers(call()[1]?.headers).get('X-Store-Id')).toBe('s-1')
  })

  it('leaves the description out of a new tag that has none: the api refuses null there', async () => {
    const { client, call } = setup(tag, 201)
    await createStoreTag(client, 's-1', { name: 'VIP', color: '#aabbcc', description: null })
    expect(call()[1]?.method).toBe('POST')
    expect(bodyOf(call()[1])).toEqual({ name: 'VIP', color: '#aabbcc' })
  })

  it('sends the description of a new tag when it has one', async () => {
    const { client, call } = setup(tag, 201)
    await createStoreTag(client, 's-1', { name: 'VIP', color: '#aabbcc', description: 'Best' })
    expect(bodyOf(call()[1])).toEqual({ name: 'VIP', color: '#aabbcc', description: 'Best' })
  })

  it('sends null to clear a description on update, and only the fields given', async () => {
    const { client, call } = setup(tag)
    await updateStoreTag(client, 's-1', 't/1', { description: null })
    expect(call()[0]).toBe('https://api.example.com/api/v1/settings/tags/t%2F1')
    expect(call()[1]?.method).toBe('PATCH')
    expect(bodyOf(call()[1])).toEqual({ description: null })
  })

  it('deletes by id and surfaces the code of a refusal', async () => {
    const ok = setup(undefined, 204)
    await expect(deleteStoreTag(ok.client, 's-1', 't1')).resolves.toBeUndefined()
    expect(ok.call()[1]?.method).toBe('DELETE')
    const refused = setup({ code: 'RESOURCE_CONFLICT', message: 'x' }, 409)
    await expect(deleteStoreTag(refused.client, 's-1', 't1')).rejects.toBeInstanceOf(ApiError)
  })
})

describe('snippet requests', () => {
  it('reads the list with the date as text', async () => {
    const { client } = setup([snippet])
    await expect(fetchStoreSnippets(client, 's-1')).resolves.toEqual([snippet])
  })

  it('creates with exactly shortcut, title and content', async () => {
    const { client, call } = setup(snippet, 201)
    await createStoreSnippet(client, 's-1', { shortcut: 'gracias', title: 'Thanks', content: 'Hi' })
    expect(call()[1]?.method).toBe('POST')
    expect(bodyOf(call()[1])).toEqual({ shortcut: 'gracias', title: 'Thanks', content: 'Hi' })
  })

  it('updates with only what changed and deletes by id', async () => {
    const update = setup(snippet)
    await updateStoreSnippet(update.client, 's-1', 's1', { title: 'New' })
    expect(update.call()[0]).toBe('https://api.example.com/api/v1/settings/snippets/s1')
    expect(bodyOf(update.call()[1])).toEqual({ title: 'New' })
    const remove = setup(undefined, 204)
    await deleteStoreSnippet(remove.client, 's-1', 's1')
    expect(remove.call()[1]?.method).toBe('DELETE')
  })
})

describe('inbox and preferences requests', () => {
  it('reads the inbox settings without exposing requestCsat', async () => {
    const { client } = setup(inbox)
    const view = await fetchInboxSettings(client, 's-1')
    expect(view).not.toHaveProperty('requestCsat')
    expect(view.reopenWindowDays).toBeNull()
  })

  it('patches only the fields given', async () => {
    const { client, call } = setup(inbox)
    await saveInboxSettings(client, 's-1', { autoArchiveAfterDays: 14 })
    expect(call()[0]).toBe('https://api.example.com/api/v1/settings/inbox')
    expect(call()[1]?.method).toBe('PATCH')
    expect(bodyOf(call()[1])).toEqual({ autoArchiveAfterDays: 14 })
  })

  it('reads and puts the switches of the store preferences, one key at a time', async () => {
    const view = { sendReadReceipts: true, assignOnReply: true }
    const read = setup(view)
    // A key the api did not send reads as its factory default
    await expect(fetchPreferences(read.client, 's-1')).resolves.toMatchObject(view)
    await expect(fetchPreferences(read.client, 's-1')).resolves.toMatchObject({
      orders: { confirmOnCreate: false, sendSummaryOnCreate: true },
      remittances: { overdueAfterDays: 7 }
    })
    expect(read.call()[0]).toBe('https://api.example.com/api/v1/settings/preferences')
    const put = setup({ ...view, sendReadReceipts: false })
    await savePreferences(put.client, 's-1', { sendReadReceipts: false })
    expect(put.call()[1]?.method).toBe('PUT')
    expect(bodyOf(put.call()[1])).toEqual({ sendReadReceipts: false })
    const second = setup({ ...view, assignOnReply: false })
    await savePreferences(second.client, 's-1', { assignOnReply: false })
    expect(bodyOf(second.call()[1])).toEqual({ assignOnReply: false })
  })
})
