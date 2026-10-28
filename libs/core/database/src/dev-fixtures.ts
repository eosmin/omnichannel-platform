import { RoleNames } from '@platform/core/auth'
import { encryptJson } from '@platform/core/crypto'
import {
  AuthorType,
  ChannelConnectionStatus,
  ChannelType,
  ConversationStatus,
  DeliveryStatus,
  MessageType,
  OfficialPluginAuthor,
  PluginCatalogTypes,
  PluginInstallationStatus,
  PluginPricingModels,
  PluginStatus
} from '@platform/core/domain'

import type { PrismaClient } from '../generated/client/client'

import { ensureMembership, ensureStore, ensureSystemRoles, ensureUser } from './bootstrap-owner'

const PRODUCT_COUNT = 30
const CUSTOMER_COUNT = 25
const CONVERSATION_STATUSES = [
  ConversationStatus.OPEN,
  ConversationStatus.PENDING,
  ConversationStatus.RESOLVED
]
const FIXTURE_TAGS = [
  { name: 'vip', color: '#8b5cf6' },
  { name: 'urgent', color: '#ef4444' },
  { name: 'wholesale', color: '#3b82f6' }
]

// Development and CI data, never production: four users without passwords (login is a magic link),
// two stores, products, customers and conversations. Deterministic, so a test can rely on it, and
// idempotent, so running it again changes nothing.
export async function loadDevFixtures(prisma: PrismaClient, encryptionKey: Buffer): Promise<void> {
  const roles = await ensureSystemRoles(prisma)
  const organization = await prisma.organization.upsert({
    where: { slug: 'test-org' },
    create: { name: 'Test Organization', slug: 'test-org' },
    update: {}
  })
  // The second store exists so that switching between stores can be tested
  const main = await ensureStore(prisma, organization.id, 'Main Store')
  const escalon = await ensureStore(prisma, organization.id, 'Tienda Escalón')

  const admin = await ensureUser(prisma, 'admin@test.com', 'Admin User')
  const agent = await ensureUser(prisma, 'agent@test.com', 'Agent User')
  const viewer = await ensureUser(prisma, 'viewer@test.com', 'Viewer User')
  const multi = await ensureUser(prisma, 'multi-store@test.com', 'Multi Store User')
  const organizationId = organization.id
  await ensureMembership(prisma, {
    userId: admin.id,
    organizationId,
    storeId: main.id,
    roleId: roles[RoleNames.ADMIN].id
  })
  await ensureMembership(prisma, {
    userId: agent.id,
    organizationId,
    storeId: main.id,
    roleId: roles[RoleNames.AGENT].id
  })
  await ensureMembership(prisma, {
    userId: viewer.id,
    organizationId,
    storeId: main.id,
    roleId: roles[RoleNames.VIEWER].id
  })
  await ensureMembership(prisma, {
    userId: multi.id,
    organizationId,
    storeId: main.id,
    roleId: roles[RoleNames.ADMIN].id
  })
  await ensureMembership(prisma, {
    userId: multi.id,
    organizationId,
    storeId: escalon.id,
    roleId: roles[RoleNames.AGENT].id
  })

  // The catalog row of WhatsApp, which the api rewrites at boot, and its installation in the store
  await prisma.plugin.upsert({
    where: { id: ChannelType.WHATSAPP },
    create: {
      id: ChannelType.WHATSAPP,
      name: 'WhatsApp',
      authorName: OfficialPluginAuthor.NAME,
      authorEmail: OfficialPluginAuthor.EMAIL,
      type: PluginCatalogTypes.CHANNEL,
      isOfficial: true,
      manifest: {},
      pricingModel: PluginPricingModels.FREE,
      status: PluginStatus.APPROVED
    },
    update: {}
  })
  const installation = await prisma.pluginInstallation.upsert({
    where: { storeId_pluginId: { storeId: main.id, pluginId: ChannelType.WHATSAPP } },
    create: {
      storeId: main.id,
      pluginId: ChannelType.WHATSAPP,
      scopes: [],
      status: PluginInstallationStatus.ACTIVE,
      installedBy: admin.id
    },
    update: {}
  })

  // Dummy credentials, encrypted like the real ones
  const connection = await prisma.channelConnection.upsert({
    where: {
      pluginId_connectionId: {
        pluginId: ChannelType.WHATSAPP,
        connectionId: 'fixture-phone-number-id'
      }
    },
    create: {
      storeId: main.id,
      pluginId: ChannelType.WHATSAPP,
      installationId: installation.id,
      connectionId: 'fixture-phone-number-id',
      displayName: '+503 2222-3333',
      status: ChannelConnectionStatus.ACTIVE,
      credentials: encryptJson(
        { accessToken: 'fixture-token', businessAccountId: 'fixture-waba' },
        encryptionKey
      )
    },
    update: {}
  })

  for (const tag of FIXTURE_TAGS) {
    await prisma.tag.upsert({
      where: { storeId_name: { storeId: main.id, name: tag.name } },
      create: { storeId: main.id, ...tag },
      update: {}
    })
  }

  for (let index = 0; index < PRODUCT_COUNT; index++) {
    const sku = `SKU-${String(index).padStart(4, '0')}`
    await prisma.product.upsert({
      where: { storeId_sku: { storeId: main.id, sku } },
      create: {
        storeId: main.id,
        sku,
        name: `Fixture product ${index}`,
        description: `Description of fixture product ${index}`,
        priceCents: 500 + index * 650
      },
      update: {}
    })
  }

  for (let index = 0; index < CUSTOMER_COUNT; index++) {
    await loadFixtureCustomer(prisma, {
      storeId: main.id,
      connectionId: connection.id,
      authorId: admin.id,
      index
    })
  }
}

interface FixtureCustomer {
  storeId: string
  connectionId: string
  authorId: string
  index: number
}

// A customer, its WhatsApp identity, its conversation and its messages are one unit: either all of
// them exist or none does. The identity (store, channel, phone) is the natural key, so a run that
// stopped halfway is completed by the next one and a finished customer is left alone.
async function loadFixtureCustomer(prisma: PrismaClient, fixture: FixtureCustomer): Promise<void> {
  const { storeId, connectionId, authorId, index } = fixture
  const phoneDigits = `5037${String(1000000 + index)}`
  const existing = await prisma.customerIdentity.findUnique({
    where: {
      storeId_channelType_channelIdentity: {
        storeId,
        channelType: ChannelType.WHATSAPP,
        channelIdentity: phoneDigits
      }
    }
  })
  if (existing !== null) return

  await prisma.$transaction(async tx => {
    const customer = await tx.customer.create({
      data: {
        storeId,
        name: `Fixture customer ${index}`,
        email: `customer${index}@example.com`,
        phone: `+${phoneDigits}`,
        phoneNormalized: phoneDigits
      }
    })
    const identity = await tx.customerIdentity.create({
      data: {
        storeId,
        customerId: customer.id,
        channelType: ChannelType.WHATSAPP,
        channelIdentity: phoneDigits,
        lastInboundAt: new Date()
      }
    })
    const conversation = await tx.conversation.create({
      data: {
        storeId,
        customerId: customer.id,
        customerIdentityId: identity.id,
        channelConnectionId: connectionId,
        channelType: ChannelType.WHATSAPP,
        status:
          CONVERSATION_STATUSES[index % CONVERSATION_STATUSES.length] ?? ConversationStatus.OPEN,
        lastMessageAt: new Date()
      }
    })
    const messageCount = 3 + (index % 10)
    await tx.message.createMany({
      data: Array.from({ length: messageCount }, (_, position) => {
        const fromCustomer = position % 2 === 0
        return {
          storeId,
          conversationId: conversation.id,
          type: MessageType.TEXT,
          content: `Fixture message ${position} of conversation ${index}`,
          authorType: fromCustomer ? AuthorType.CUSTOMER : AuthorType.AGENT,
          authorId: fromCustomer ? null : authorId,
          channelMessageId: fromCustomer ? `wamid.fixture-${index}-${position}` : null,
          deliveryStatus: fromCustomer ? null : DeliveryStatus.DELIVERED
        }
      })
    })
  })
}
