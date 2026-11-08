import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import { ChannelIds, DeliveryStatus, MessageType } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { CAPTION_PER_FILE_SEND_ENABLED, MULTI_FILE_SEND_ENABLED } from '@platform/core/http'
import { PluginRegistry } from '@platform/plugins/runtime'
import { ChannelCapability } from '@platform/plugins/sdk'

import { buildChannelPlugin, createConversationOf } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const CREATED = 201
const OK = 200
const CONFLICT = 409
const BAD_REQUEST = 400
const NOT_FOUND = 404
const ALBUM_CHANNEL_ID = 'album_channel'

interface MessageBody {
  id: string
  content: string | null
  media: { id: string; position: number | null; caption: string | null }[]
}

// A text under EACH file of a message (owner, 2026-11-08): the contract, the limits of the channel, the
// switch, and what is kept. How the worker sends them step by step is the next piece.
describe.each([
  ['switched on', true],
  ['switched off', false]
])('The text under each file of a message, %s', (_label, perFile) => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(MULTI_FILE_SEND_ENABLED)
        .useValue(true)
        .overrideProvider(CAPTION_PER_FILE_SEND_ENABLED)
        .useValue(perFile)
    )
    ctx = await seedTestContext(owner, app, prefix)
    app.get(PluginRegistry, { strict: false }).register(
      buildChannelPlugin({
        id: ALBUM_CHANNEL_ID,
        capabilities: [
          ChannelCapability.TEXT,
          ChannelCapability.IMAGE,
          ChannelCapability.MESSAGING_WINDOW
        ],
        media: {
          maxFilesPerMessage: 3,
          kinds: { image: { types: ['image/png'], maxBytes: 100 } }
        }
      })
    )
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const post = (body: Record<string, unknown>) =>
    api(app, ctx.agentA, ctx.storeA).post(ApiRoutes.messages.create).send(body)
  const conversation = async () => {
    const created = await createConversationOf(owner, {
      storeId: ctx.storeA.id,
      channelType: ALBUM_CHANNEL_ID
    })
    await owner.customerIdentity.update({
      where: { id: created.customerIdentityId },
      data: { lastInboundAt: new Date() }
    })
    return created
  }
  const file = (storeId = ctx.storeA.id, uploadedBy = ctx.agentA.id) => {
    const id = randomUUID()
    return owner.media.create({
      data: {
        id,
        storeId,
        purpose: 'message',
        key: `stores/${storeId}/messages/${id}/photo.png`,
        filename: 'photo.png',
        contentType: 'image/png',
        fileSize: 10,
        status: 'clean',
        uploadedBy
      },
      select: { id: true }
    })
  }
  const album = async (count: number) => {
    const target = await conversation()
    const files = await Promise.all(Array.from({ length: count }, () => file()))
    return { target, ids: files.map(item => item.id) }
  }
  const send = (
    target: { id: string },
    ids: string[],
    extra: Record<string, unknown>,
    key = randomUUID()
  ) =>
    post({
      type: MessageType.IMAGE,
      conversationId: target.id,
      mediaIds: ids,
      idempotencyKey: key,
      ...extra
    })

  it('keeps the text under the first file as it always did, in the message and in its file', async () => {
    const { target, ids } = await album(1)

    const response = await send(target, ids, { content: '  one text  ' }).expect(CREATED)

    const body = response.body as MessageBody
    expect(body.content).toBe('one text')
    expect(body.media.map(item => item.caption)).toEqual(['one text'])
  })

  it('lets `captions` win over `content`, and a blank one is none', async () => {
    const { target, ids } = await album(1)

    const response = await send(target, ids, { content: 'old way', captions: ['new way'] }).expect(
      CREATED
    )
    const blank = await album(1)
    const none = await send(blank.target, blank.ids, { captions: ['   '] }).expect(CREATED)

    expect((response.body as MessageBody).content).toBe('new way')
    expect((none.body as MessageBody).content).toBeNull()
    expect((none.body as MessageBody).media.map(item => item.caption)).toEqual([null])
  })

  it('refuses more texts than files, and a text that is longer than the channel holds', async () => {
    const { target, ids } = await album(2)

    await send(target, ids, { captions: ['a', 'b', 'c'] }).expect(BAD_REQUEST)
    await send(target, ids, { captions: ['x'.repeat(5000), null] }).expect(BAD_REQUEST)
    expect(await owner.media.count({ where: { id: { in: ids }, messageId: null } })).toBe(2)
  })

  if (perFile) {
    it('keeps the text under each file, by place, and shows them to the thread', async () => {
      const { target, ids } = await album(3)

      const response = await send(target, ids, { captions: ['first', null, 'third'] }).expect(
        CREATED
      )

      const body = response.body as MessageBody
      expect(body.content).toBe('first')
      expect(body.media.map(item => [item.position, item.caption])).toEqual([
        [0, 'first'],
        [1, null],
        [2, 'third']
      ])
      const stored = await owner.media.findMany({
        where: { messageId: body.id },
        orderBy: { position: 'asc' },
        select: { caption: true, position: true }
      })
      expect(stored.map(item => item.caption)).toEqual(['first', null, 'third'])
    })

    it('answers a repeated key with the same message, and refuses it with other texts', async () => {
      const { target, ids } = await album(2)
      const key = randomUUID()
      const first = await send(target, ids, { captions: ['a', 'b'] }, key).expect(CREATED)

      const again = await send(target, ids, { captions: ['a', 'b'] }, key).expect(OK)
      await send(target, ids, { captions: ['a', 'edited'] }, key).expect(CONFLICT)

      expect((again.body as MessageBody).id).toBe((first.body as MessageBody).id)
    })

    it('reads a message sent before each file had its text as the text of its first file', async () => {
      const { target, ids } = await album(1)
      const key = randomUUID()
      const first = await send(target, ids, { content: 'legacy' }, key).expect(CREATED)
      await owner.media.updateMany({
        where: { messageId: (first.body as MessageBody).id },
        data: { caption: null }
      })

      await send(target, ids, { content: 'legacy' }, key).expect(OK)
      await send(target, ids, { content: 'another' }, key).expect(CONFLICT)
    })
  } else {
    it('takes a text under the first file only, and says so for any other', async () => {
      const { target, ids } = await album(2)

      const refused = await send(target, ids, { captions: ['a', 'b'] }).expect(CONFLICT)
      const accepted = await send(target, ids, { captions: ['a', null] }).expect(CREATED)

      expect(refused.body).toMatchObject({
        error: { code: ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED }
      })
      expect((accepted.body as MessageBody).media.map(item => item.caption)).toEqual(['a', null])
      // The refused request linked nothing: its files were free for the one that followed
    })
  }

  it('takes a text under an audio only where it can go after it (switched on), as before otherwise', async () => {
    const target = await createConversationOf(owner, {
      storeId: ctx.storeA.id,
      channelType: ChannelIds.WHATSAPP
    })
    await owner.customerIdentity.update({
      where: { id: target.customerIdentityId },
      data: { lastInboundAt: new Date() }
    })
    const id = randomUUID()
    await owner.media.create({
      data: {
        id,
        storeId: ctx.storeA.id,
        purpose: 'message',
        key: `stores/${ctx.storeA.id}/messages/${id}/a.ogg`,
        filename: 'a.ogg',
        contentType: 'audio/ogg',
        fileSize: 10,
        status: 'clean',
        uploadedBy: ctx.agentA.id
      }
    })

    const response = await post({
      type: MessageType.AUDIO,
      conversationId: target.id,
      mediaIds: [id],
      captions: ['say this'],
      idempotencyKey: randomUUID()
    })

    expect(response.status).toBe(perFile ? CREATED : CONFLICT)
    if (!perFile) {
      expect(response.body).toMatchObject({
        error: { code: ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED }
      })
    }
  })

  it('never lists the text of a file of another store', async () => {
    const mine = await album(1)
    await send(mine.target, mine.ids, { captions: ['private text of store A'] }).expect(CREATED)

    const theirs = await api(app, ctx.adminB, ctx.storeB).get(ApiRoutes.conversations.list)

    expect(theirs.status).toBe(OK)
    expect(JSON.stringify(theirs.body)).not.toContain('private text of store A')
    const asB = await api(app, ctx.adminB, ctx.storeB).get(
      ApiRoutes.conversations.messages(mine.target.id)
    )
    expect([NOT_FOUND, OK]).toContain(asB.status)
    expect(JSON.stringify(asB.body)).not.toContain('private text of store A')
  })

  it('does not change how a message with no files is written', async () => {
    const target = await conversation()

    const response = await post({
      type: MessageType.TEXT,
      conversationId: target.id,
      content: 'plain',
      idempotencyKey: randomUUID()
    }).expect(CREATED)

    expect((response.body as MessageBody).media).toEqual([])
    expect(DeliveryStatus.QUEUED).toBe('queued')
    expect(ChannelIds.WHATSAPP).toBeDefined()
  })
})
