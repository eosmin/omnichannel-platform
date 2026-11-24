import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { MediaStatus, MessageType } from '@platform/core/domain'
import { MediaPurpose } from '@platform/core/storage'

import { createConversationOf, createMessage, createRole } from '../builders'
import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const FILENAME = 'cedula-de-ana.pdf'

interface FileView {
  id: string
  filename: string | null
  contentType: string | null
  fileSize: number | null
  status: string
}

// BAN-R-meta (owner decision, 2026-11-24): who may not see files (`media:view`) gets the thread without the name, the type and
// the size of the files
describe('The files of a message for a reader without media:view', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let conversationId: string
  let mediaId: string

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })
    conversationId = conversation.id
    const message = await createMessage(owner, {
      storeId: ctx.storeA.id,
      conversationId,
      type: MessageType.DOCUMENT,
      content: 'adjunto'
    })
    const media = await owner.media.create({
      data: {
        storeId: ctx.storeA.id,
        messageId: message.id,
        purpose: MediaPurpose.MESSAGE,
        key: `${prefix}/message/${randomUUID()}`,
        filename: FILENAME,
        contentType: 'application/pdf',
        fileSize: 4096,
        status: MediaStatus.CLEAN
      },
      select: { id: true }
    })
    mediaId = media.id
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const reader = async (
    name: string,
    permissions: readonly (typeof Permissions)[keyof typeof Permissions][]
  ) => {
    const role = await createRole(owner, { storeId: ctx.storeA.id, permissions })
    return createActor(owner, app, {
      prefix,
      name,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: role.id
    })
  }
  const filesSeenBy = async (actor: Awaited<ReturnType<typeof reader>>): Promise<FileView[]> => {
    const response = await api(app, actor, ctx.storeA).get(
      ApiRoutes.conversations.messages(conversationId)
    )
    expect(response.status).toBe(OK)
    const thread = response.body as { data: { media: FileView[] }[] }
    return thread.data.flatMap(message => message.media)
  }

  it('does not give the name, the type or the size, and keeps the file itself in the thread', async () => {
    const blind = await reader('noMedia', [
      Permissions.CONVERSATIONS_VIEW,
      Permissions.CONVERSATIONS_VIEW_ALL,
      Permissions.MESSAGES_VIEW
    ])
    const files = await filesSeenBy(blind)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      id: mediaId,
      filename: null,
      contentType: null,
      fileSize: null
    })
  })

  it('gives them to who holds media:view', async () => {
    const seer = await reader('withMedia', [
      Permissions.CONVERSATIONS_VIEW,
      Permissions.CONVERSATIONS_VIEW_ALL,
      Permissions.MESSAGES_VIEW,
      Permissions.MEDIA_VIEW
    ])
    const files = await filesSeenBy(seer)
    expect(files[0]).toMatchObject({
      id: mediaId,
      filename: FILENAME,
      contentType: 'application/pdf',
      fileSize: 4096
    })
  })
})
