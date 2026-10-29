import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions, RoleNames } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  ChannelType,
  ConversationStatus,
  MembershipStatus,
  RoutingActionTypes,
  RoutingLimits
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { ConversationsService, RoutingService } from '@platform/core/messaging'

import { createConversationOf, createCustomer, createRoutingRule, createTag } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { anonymousApi, api } from '../helpers/http'

interface RuleBody {
  id: string
  name: string
  priority: number
  enabled: boolean
  conditions: Record<string, unknown>
  action: { type: string; userIds?: string[] }
}
interface ErrorBody {
  error: {
    code: string
    metadata?: { ids?: string[]; issues?: { path: string; code: string }[] }
  }
}

const OK = 200
const CREATED = 201
const NO_CONTENT = 204
const BAD_REQUEST = 400
const UNAUTHORIZED = 401
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

const { ASSIGN_USER, ROUND_ROBIN, UNASSIGNED } = RoutingActionTypes

describe('The routing rules of a store', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  // The suite works in the sibling store: its own rules, its own people
  let ana: { id: string; email: string; token: string }
  let beto: { id: string; email: string; token: string }
  let carla: { id: string; email: string; token: string }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const member = (name: string) =>
      createActor(owner, app, {
        prefix,
        name,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA2.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
    ana = await member('anaRouting')
    beto = await member('betoRouting')
    carla = await member('carlaRouting')
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  // Each test starts with no rules and no conversations in the store: the round robin counts them
  beforeEach(async () => {
    await owner.routingRule.deleteMany({ where: { storeId: ctx.storeA2.id } })
    await owner.conversation.deleteMany({ where: { storeId: ctx.storeA2.id } })
  })

  const storeId = () => ctx.storeA2.id
  const asAdmin = () => api(app, ctx.adminA2, ctx.storeA2)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const issuesOf = (body: unknown) =>
    ((body as ErrorBody).error.metadata?.issues ?? []).map(issue => `${issue.path}:${issue.code}`)
  const rulesOf = async (): Promise<RuleBody[]> =>
    (await asAdmin().get(ApiRoutes.settings.routing)).body as RuleBody[]
  const body = (extra: Record<string, unknown> = {}) => ({
    name: 'Catch all',
    conditions: {},
    action: { type: UNASSIGNED },
    ...extra
  })
  const create = (extra: Record<string, unknown> = {}) =>
    asAdmin().post(ApiRoutes.settings.routing).send(body(extra))

  // The audit entry is written after the answer: wait for it instead of guessing a delay
  async function auditEntries(resourceId: string, expected = 1) {
    const where = { action: AuditAction.ROUTING_RULE_CHANGED, resourceId }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const entries = await owner.auditLog.findMany({ where })
      if (entries.length >= expected) return entries
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return owner.auditLog.findMany({ where })
  }

  describe('creating one', () => {
    it('goes last, enabled, and is audited', async () => {
      const first = await create({ name: 'First' })
      const second = await create({ name: 'Second', enabled: false })

      expect(first.status).toBe(CREATED)
      expect((first.body as RuleBody).priority).toBe(1)
      expect((first.body as RuleBody).enabled).toBe(true)
      expect(second.body as RuleBody).toMatchObject({ priority: 2, enabled: false })
      const entries = await auditEntries((first.body as RuleBody).id)
      expect(entries).toHaveLength(1)
      expect(entries[0]?.metadata).toMatchObject({
        change: 'created',
        name: 'First',
        enabled: true,
        conditions: {},
        action: { type: UNASSIGNED }
      })
    })

    it('keeps the conditions and the action as given', async () => {
      const tag = await createTag(owner, { storeId: storeId() })

      const response = await create({
        conditions: {
          channelTypes: [ChannelType.WHATSAPP, ChannelType.INSTAGRAM],
          tagIds: [tag.id],
          keywords: ['Envío', 'precio'],
          outsideBusinessHours: true
        },
        action: { type: ROUND_ROBIN, userIds: [ana.id, beto.id] }
      })

      expect(response.status).toBe(CREATED)
      expect(response.body).toMatchObject({
        conditions: {
          channelTypes: [ChannelType.WHATSAPP, ChannelType.INSTAGRAM],
          tagIds: [tag.id],
          keywords: ['Envío', 'precio'],
          outsideBusinessHours: true
        },
        action: { type: ROUND_ROBIN, userIds: [ana.id, beto.id] }
      })
    })

    it('records who made it', async () => {
      const response = await create()

      const row = await owner.routingRule.findUniqueOrThrow({
        where: { id: (response.body as RuleBody).id }
      })
      expect(row.createdBy).toBe(ctx.adminA2.id)
      expect(row.storeId).toBe(storeId())
    })

    it.each([
      ['no name', { name: undefined }],
      ['a blank name', { name: '   ' }],
      ['a name with a control character', { name: 'a\nb' }],
      ['a name that is too long', { name: 'n'.repeat(RoutingLimits.NAME_MAX_LENGTH + 1) }],
      ['a priority', { priority: 1 }],
      ['a store', { storeId: randomUUID() }],
      ['no conditions', { conditions: undefined }],
      ['no action', { action: undefined }],
      ['an unknown condition', { conditions: { intents: ['refund'] } }],
      ['an empty list of channels', { conditions: { channelTypes: [] } }],
      // A well-formed id nobody registered is a 400 of the registry (channel-registry.spec.ts)
      ['a channel id that is not shaped like one', { conditions: { channelTypes: ['Fax!'] } }],
      ['a repeated channel', { conditions: { channelTypes: ['email', 'email'] } }],
      ['an empty list of keywords', { conditions: { keywords: [] } }],
      ['a blank keyword', { conditions: { keywords: [' '] } }],
      ['a keyword that is only a combining mark', { conditions: { keywords: ['\u0301'] } }],
      [
        'too many keywords',
        {
          conditions: {
            keywords: Array.from({ length: RoutingLimits.MAX_KEYWORDS + 1 }, (_, i) => `k${i}`)
          }
        }
      ],
      [
        'a keyword that is too long',
        { conditions: { keywords: ['k'.repeat(RoutingLimits.KEYWORD_MAX_LENGTH + 1)] } }
      ],
      ['a tag that is not a uuid', { conditions: { tagIds: ['vip'] } }],
      [
        'a tag listed twice',
        {
          conditions: {
            tagIds: ['aaaaaaaa-0000-4000-8000-000000000001', 'AAAAAAAA-0000-4000-8000-000000000001']
          }
        }
      ],
      [
        'too many tags',
        {
          conditions: {
            tagIds: Array.from({ length: RoutingLimits.MAX_TAGS + 1 }, () => randomUUID())
          }
        }
      ],
      ['outside hours set to false', { conditions: { outsideBusinessHours: false } }],
      ['an unknown action', { action: { type: 'escalate' } }],
      ['assign_user with nobody', { action: { type: ASSIGN_USER, userIds: [] } }],
      [
        'assign_user with two people',
        { action: { type: ASSIGN_USER, userIds: [randomUUID(), randomUUID()] } }
      ],
      ['round_robin with one person', { action: { type: ROUND_ROBIN, userIds: [randomUUID()] } }],
      [
        'round_robin with a repeated person',
        {
          action: {
            type: ROUND_ROBIN,
            userIds: [
              'b'.repeat(8) + '-0000-4000-8000-000000000000',
              'b'.repeat(8) + '-0000-4000-8000-000000000000'
            ]
          }
        }
      ],
      [
        'round_robin with too many people',
        {
          action: {
            type: ROUND_ROBIN,
            userIds: Array.from({ length: RoutingLimits.MAX_USERS_PER_ACTION + 1 }, () =>
              randomUUID()
            )
          }
        }
      ],
      ['unassigned with people', { action: { type: UNASSIGNED, userIds: [randomUUID()] } }]
    ])('refuses %s', async (_name, extra) => {
      const response = await create(extra)

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
      // The shape was refused, not the people or the tags it names: those answer with their ids
      expect(issuesOf(response.body)).not.toEqual([])
      expect(await owner.routingRule.count({ where: { storeId: storeId() } })).toBe(0)
    })

    it('says which field is wrong, not only that something is', async () => {
      const unknownCondition = await create({ conditions: { intents: ['refund'] } })
      const sentPriority = await create({ priority: 3 })
      const oneRobin = await create({ action: { type: ROUND_ROBIN, userIds: [ana.id] } })

      expect(issuesOf(unknownCondition.body)).toContain('conditions:unrecognized_keys')
      expect(issuesOf(sentPriority.body)).toContain(':unrecognized_keys')
      expect(issuesOf(oneRobin.body)).toContain('action.userIds:too_small')
    })

    it('refuses a tag of another store, naming it', async () => {
      const foreign = await createTag(owner, { storeId: ctx.storeB.id })
      const own = await createTag(owner, { storeId: storeId() })

      const response = await create({ conditions: { tagIds: [own.id, foreign.id] } })

      expect(response.status).toBe(BAD_REQUEST)
      expect((response.body as ErrorBody).error.metadata?.ids).toEqual([foreign.id])
      expect(await owner.routingRule.count({ where: { storeId: storeId() } })).toBe(0)
    })

    it.each([
      ['someone of another store', () => ctx.adminB.id],
      ['someone who does not exist', () => randomUUID()],
      ['a member of the sibling store', () => ctx.agentA.id]
    ])('refuses an action on %s', async (_name, who) => {
      const response = await create({ action: { type: ASSIGN_USER, userIds: [who()] } })

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
    })

    it('refuses a member who was removed, and a role that cannot see conversations', async () => {
      const removed = await createActor(owner, app, {
        prefix,
        name: `removedRouting${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: storeId(),
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      await owner.membership.updateMany({
        where: { userId: removed.id, storeId: storeId() },
        data: { status: MembershipStatus.REVOKED }
      })
      const blind = await actorWithPermissions(owner, app, {
        prefix,
        name: `blindRouting${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: storeId(),
        permissions: [Permissions.TEAM_VIEW]
      })

      const asRemoved = await create({ action: { type: ASSIGN_USER, userIds: [removed.id] } })
      const asBlind = await create({ action: { type: ASSIGN_USER, userIds: [blind.id] } })

      expect([asRemoved.status, asBlind.status]).toEqual([BAD_REQUEST, BAD_REQUEST])
      expect((asRemoved.body as ErrorBody).error.metadata?.ids).toEqual([removed.id])
    })

    it('keeps a person and a tag in one spelling', async () => {
      const tag = await createTag(owner, { storeId: storeId() })

      const response = await create({
        conditions: { tagIds: [tag.id.toUpperCase()] },
        action: { type: ASSIGN_USER, userIds: [ana.id.toUpperCase()] }
      })

      expect(response.status).toBe(CREATED)
      expect(response.body).toMatchObject({
        conditions: { tagIds: [tag.id] },
        action: { userIds: [ana.id] }
      })
    })

    it('stops at the limit of rules of a store', async () => {
      await owner.routingRule.createMany({
        data: Array.from({ length: RoutingLimits.MAX_RULES_PER_STORE }, (_, index) => ({
          storeId: storeId(),
          name: `bulk ${index}`,
          priority: index + 1,
          conditions: {},
          action: { type: UNASSIGNED },
          createdBy: randomUUID()
        }))
      })

      const response = await create()

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.RESOURCE_CONFLICT)
      expect(await owner.routingRule.count({ where: { storeId: storeId() } })).toBe(
        RoutingLimits.MAX_RULES_PER_STORE
      )
    })

    it('gives distinct priorities to rules created together', async () => {
      const answers = await Promise.all(
        Array.from({ length: 6 }, (_, i) => create({ name: `r${i}` }))
      )

      expect(answers.map(answer => answer.status)).toEqual(Array(6).fill(CREATED))
      const priorities = (await rulesOf()).map(rule => rule.priority)
      expect(priorities).toEqual([1, 2, 3, 4, 5, 6])
    })
  })

  describe('reading them', () => {
    it('lists the rules of the store in the order they are tried, and only those', async () => {
      const second = await createRoutingRule(owner, {
        storeId: storeId(),
        name: 'second',
        priority: 5
      })
      const first = await createRoutingRule(owner, {
        storeId: storeId(),
        name: 'first',
        priority: 2
      })
      await createRoutingRule(owner, { storeId: ctx.storeB.id, name: 'not ours' })

      const rules = await rulesOf()

      expect(rules.map(rule => rule.id)).toEqual([first.id, second.id])
    })

    it('gets one, and does not know another store’s', async () => {
      const mine = await createRoutingRule(owner, { storeId: storeId(), name: 'mine' })
      const theirs = await createRoutingRule(owner, { storeId: ctx.storeB.id })

      const found = await asAdmin().get(ApiRoutes.settings.routingRuleById(mine.id))
      const missing = await asAdmin().get(ApiRoutes.settings.routingRuleById(theirs.id))

      expect(found.status).toBe(OK)
      expect(found.body).toMatchObject({ id: mine.id, name: 'mine' })
      expect(missing.status).toBe(NOT_FOUND)
    })

    it('does not send the creator of the rule', async () => {
      await createRoutingRule(owner, { storeId: storeId() })

      const [rule] = await rulesOf()

      expect(rule).not.toHaveProperty('createdBy')
      expect(rule).not.toHaveProperty('storeId')
    })
  })

  describe('changing one', () => {
    it('changes what is sent and leaves the rest, the priority included', async () => {
      const made = await createRoutingRule(owner, {
        storeId: storeId(),
        name: 'old',
        conditions: { keywords: ['hola'] },
        action: { type: UNASSIGNED }
      })

      const response = await asAdmin()
        .patch(ApiRoutes.settings.routingRuleById(made.id))
        .send({ name: 'new', enabled: false })

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({
        name: 'new',
        enabled: false,
        priority: made.priority,
        conditions: { keywords: ['hola'] },
        action: { type: UNASSIGNED }
      })
      const entries = await auditEntries(made.id)
      expect(entries[0]?.metadata).toMatchObject({ change: 'updated', name: 'new' })
    })

    it('replaces the conditions as a whole, not field by field', async () => {
      const made = await createRoutingRule(owner, {
        storeId: storeId(),
        conditions: { keywords: ['hola'], channelTypes: [ChannelType.WEB_WIDGET] }
      })

      const response = await asAdmin()
        .patch(ApiRoutes.settings.routingRuleById(made.id))
        .send({ conditions: { keywords: ['adios'] } })

      expect((response.body as RuleBody).conditions).toEqual({ keywords: ['adios'] })
    })

    it('checks the references of what it changes', async () => {
      const made = await createRoutingRule(owner, { storeId: storeId() })

      const response = await asAdmin()
        .patch(ApiRoutes.settings.routingRuleById(made.id))
        .send({ action: { type: ASSIGN_USER, userIds: [ctx.adminB.id] } })

      expect(response.status).toBe(BAD_REQUEST)
      expect((await rulesOf())[0]?.action.type).toBe(UNASSIGNED)
    })

    it.each([
      ['nothing', {}],
      ['a priority', { priority: 3 }],
      ['a store', { storeId: randomUUID() }],
      ['a blank name', { name: ' ' }]
    ])('refuses %s', async (_name, change) => {
      const made = await createRoutingRule(owner, { storeId: storeId(), name: 'keep' })

      const response = await asAdmin()
        .patch(ApiRoutes.settings.routingRuleById(made.id))
        .send(change)

      expect(response.status).toBe(BAD_REQUEST)
      expect((await owner.routingRule.findUniqueOrThrow({ where: { id: made.id } })).name).toBe(
        'keep'
      )
    })

    it('does not know a rule of another store or one that does not exist', async () => {
      const theirs = await createRoutingRule(owner, { storeId: ctx.storeB.id, name: 'theirs' })

      const other = await asAdmin()
        .patch(ApiRoutes.settings.routingRuleById(theirs.id))
        .send({ name: 'hacked' })
      const missing = await asAdmin()
        .patch(ApiRoutes.settings.routingRuleById(randomUUID()))
        .send({ name: 'hacked' })

      expect([other.status, missing.status]).toEqual([NOT_FOUND, NOT_FOUND])
      expect((other.body as ErrorBody).error).toEqual((missing.body as ErrorBody).error)
      expect((await owner.routingRule.findUniqueOrThrow({ where: { id: theirs.id } })).name).toBe(
        'theirs'
      )
    })
  })

  describe('deleting one', () => {
    it('removes it, leaves the others and audits it', async () => {
      const keep = await createRoutingRule(owner, { storeId: storeId(), name: 'keep' })
      const drop = await createRoutingRule(owner, { storeId: storeId(), name: 'drop' })

      const response = await asAdmin().delete(ApiRoutes.settings.routingRuleById(drop.id))

      expect(response.status).toBe(NO_CONTENT)
      expect((await rulesOf()).map(rule => rule.id)).toEqual([keep.id])
      const entries = await auditEntries(drop.id)
      expect(entries[0]?.metadata).toMatchObject({ change: 'deleted', name: 'drop' })
    })

    it('leaves a gap that the next rule goes past, not into', async () => {
      await createRoutingRule(owner, { storeId: storeId() })
      const middle = await createRoutingRule(owner, { storeId: storeId() })
      await createRoutingRule(owner, { storeId: storeId() })
      await asAdmin().delete(ApiRoutes.settings.routingRuleById(middle.id)).expect(NO_CONTENT)

      const added = await create({ name: 'after the gap' })

      expect((added.body as RuleBody).priority).toBe(4)
    })

    it('does not know a rule of another store, and leaves it', async () => {
      const theirs = await createRoutingRule(owner, { storeId: ctx.storeB.id })

      const response = await asAdmin().delete(ApiRoutes.settings.routingRuleById(theirs.id))

      expect(response.status).toBe(NOT_FOUND)
      expect(await owner.routingRule.count({ where: { id: theirs.id } })).toBe(1)
    })
  })

  describe('putting them in order', () => {
    it('applies the order it is given, with priorities from 1 and no gap', async () => {
      const a = await createRoutingRule(owner, { storeId: storeId(), name: 'a', priority: 4 })
      const b = await createRoutingRule(owner, { storeId: storeId(), name: 'b', priority: 9 })
      const c = await createRoutingRule(owner, { storeId: storeId(), name: 'c', priority: 12 })

      const response = await asAdmin()
        .patch(ApiRoutes.settings.routingOrder)
        .send({ ruleIds: [c.id, a.id, b.id] })

      expect(response.status).toBe(OK)
      const rules = response.body as RuleBody[]
      expect(rules.map(rule => [rule.name, rule.priority])).toEqual([
        ['c', 1],
        ['a', 2],
        ['b', 3]
      ])
      expect((await rulesOf()).map(rule => rule.name)).toEqual(['c', 'a', 'b'])
      const entries = await auditEntries(storeId())
      expect(entries.map(entry => entry.metadata)).toContainEqual({
        change: 'reordered',
        ruleIds: [c.id, a.id, b.id]
      })
    })

    it('swaps two rules, which the unique priority makes hard to do one by one', async () => {
      const a = await createRoutingRule(owner, { storeId: storeId(), name: 'a' })
      const b = await createRoutingRule(owner, { storeId: storeId(), name: 'b' })

      const response = await asAdmin()
        .patch(ApiRoutes.settings.routingOrder)
        .send({ ruleIds: [b.id, a.id] })

      expect(response.status).toBe(OK)
      expect((await rulesOf()).map(rule => rule.name)).toEqual(['b', 'a'])
    })

    it.each([
      ['a rule missing', (ids: string[]) => ids.slice(1)],
      ['a rule more, that does not exist', (ids: string[]) => [...ids, randomUUID()]]
    ])('does not apply an order with %s: the list changed', async (_name, change) => {
      const a = await createRoutingRule(owner, { storeId: storeId(), name: 'a' })
      const b = await createRoutingRule(owner, { storeId: storeId(), name: 'b' })

      const response = await asAdmin()
        .patch(ApiRoutes.settings.routingOrder)
        .send({ ruleIds: change([b.id, a.id]) })

      expect(response.status).toBe(CONFLICT)
      expect((await rulesOf()).map(rule => rule.name)).toEqual(['a', 'b'])
    })

    it('does not apply an order that swaps one rule of the store for one it does not have', async () => {
      const a = await createRoutingRule(owner, { storeId: storeId(), name: 'a' })
      const b = await createRoutingRule(owner, { storeId: storeId(), name: 'b' })
      const foreign = await createRoutingRule(owner, { storeId: ctx.storeB.id, priority: 55 })

      const answers = [
        await asAdmin()
          .patch(ApiRoutes.settings.routingOrder)
          .send({ ruleIds: [a.id, randomUUID()] }),
        await asAdmin()
          .patch(ApiRoutes.settings.routingOrder)
          .send({ ruleIds: [b.id, foreign.id] })
      ]

      expect(answers.map(answer => answer.status)).toEqual([CONFLICT, CONFLICT])
      expect((await rulesOf()).map(rule => rule.name)).toEqual(['a', 'b'])
      expect(
        (await owner.routingRule.findUniqueOrThrow({ where: { id: foreign.id } })).priority
      ).toBe(55)
    })

    it('does not take a rule of another store into the order', async () => {
      const mine = await createRoutingRule(owner, { storeId: storeId(), name: 'mine' })
      const theirs = await createRoutingRule(owner, { storeId: ctx.storeB.id, priority: 77 })

      const response = await asAdmin()
        .patch(ApiRoutes.settings.routingOrder)
        .send({ ruleIds: [mine.id, theirs.id] })

      expect(response.status).toBe(CONFLICT)
      expect(
        (await owner.routingRule.findUniqueOrThrow({ where: { id: theirs.id } })).priority
      ).toBe(77)
    })

    it.each([
      ['an empty list', []],
      ['a repeated rule', ['x', 'x']],
      ['something that is not an id', ['nope']]
    ])('refuses %s', async (_name, ruleIds) => {
      await createRoutingRule(owner, { storeId: storeId() })
      const ids = ruleIds.map(id => (id === 'x' ? '11111111-1111-4111-8111-111111111111' : id))

      const response = await asAdmin().patch(ApiRoutes.settings.routingOrder).send({ ruleIds: ids })

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
    })

    it('is not read as the id of a rule', async () => {
      const made = await createRoutingRule(owner, { storeId: storeId() })

      const response = await asAdmin()
        .patch(ApiRoutes.settings.routingOrder)
        .send({ ruleIds: [made.id] })

      expect(response.status).toBe(OK)
    })

    it('leaves a consistent order when several orders and creations arrive together', async () => {
      const made: { id: string }[] = []
      for (let index = 0; index < 4; index += 1) {
        made.push(await createRoutingRule(owner, { storeId: storeId(), name: `m${index}` }))
      }
      const ids = made.map(rule => rule.id)

      const answers = await Promise.all([
        asAdmin()
          .patch(ApiRoutes.settings.routingOrder)
          .send({ ruleIds: [...ids].reverse() }),
        asAdmin().patch(ApiRoutes.settings.routingOrder).send({ ruleIds: ids }),
        create({ name: 'late' })
      ])

      // Whichever came first, the creation worked, no request failed with a server error, and the
      // priorities are one run from 1 with every rule in it (a reorder that lost to the creation
      // answers 409: it was drawn from the list as it was)
      expect(answers[2]?.status).toBe(CREATED)
      for (const answer of answers) expect([OK, CREATED, CONFLICT]).toContain(answer.status)
      const priorities = (await rulesOf()).map(rule => rule.priority)
      expect(priorities.length).toBeGreaterThanOrEqual(5)
      expect(priorities).toEqual(Array.from({ length: priorities.length }, (_, index) => index + 1))
    })
  })

  describe('the tags they name', () => {
    it('cannot be deleted while a rule names them, and can once it does not', async () => {
      const tag = await createTag(owner, { storeId: storeId() })
      const spare = await createTag(owner, { storeId: storeId() })
      const rule = await create({ conditions: { tagIds: [tag.id] } })
      const ruleId = (rule.body as RuleBody).id

      const refused = await asAdmin().delete(ApiRoutes.settings.tagById(tag.id))
      const unrelated = await asAdmin().delete(ApiRoutes.settings.tagById(spare.id))
      await asAdmin()
        .patch(ApiRoutes.settings.routingRuleById(ruleId))
        .send({ conditions: { keywords: ['hola'] } })
        .expect(OK)
      const allowed = await asAdmin().delete(ApiRoutes.settings.tagById(tag.id))

      expect(refused.status).toBe(CONFLICT)
      expect(codeOf(refused.body)).toBe(ErrorCodes.RESOURCE_CONFLICT)
      expect(await owner.tag.count({ where: { id: tag.id } })).toBe(0)
      expect([unrelated.status, allowed.status]).toEqual([NO_CONTENT, NO_CONTENT])
    })

    it('are not deleted under a rule that is being born, nor a rule born under a deleted tag', async () => {
      for (let round = 0; round < 8; round += 1) {
        await owner.routingRule.deleteMany({ where: { storeId: storeId() } })
        const tag = await createTag(owner, { storeId: storeId() })

        const [made, deleted] = await Promise.all([
          create({ conditions: { tagIds: [tag.id] } }),
          asAdmin().delete(ApiRoutes.settings.tagById(tag.id))
        ])

        // One of the two came first and the other found what it left: the rule exists with its tag,
        // or neither does; never a rule that names a tag that is gone, and no server error
        const rules = await owner.routingRule.count({ where: { storeId: storeId() } })
        const tagStillThere = await owner.tag.count({ where: { id: tag.id } })
        expect(rules).toBe(tagStillThere)
        expect(made?.status === CREATED || deleted?.status === NO_CONTENT).toBe(true)
        expect([made?.status, deleted?.status]).not.toContain(500)
      }
    })
  })

  describe('who may', () => {
    it('answers 401 with no token', async () => {
      const made = await createRoutingRule(owner, { storeId: storeId() })
      const anon = anonymousApi(app)

      const answers = [
        await anon.get(ApiRoutes.settings.routing),
        await anon.post(ApiRoutes.settings.routing).send(body()),
        await anon.patch(ApiRoutes.settings.routingRuleById(made.id)).send({ name: 'x' }),
        await anon.delete(ApiRoutes.settings.routingRuleById(made.id)),
        await anon.patch(ApiRoutes.settings.routingOrder).send({ ruleIds: [made.id] })
      ]

      expect(answers.map(answer => answer.status)).toEqual(Array(5).fill(UNAUTHORIZED))
    })

    it('lets who can see the settings read, and not change', async () => {
      const made = await createRoutingRule(owner, { storeId: storeId() })
      const reader = await actorWithPermissions(owner, app, {
        prefix,
        name: `readerRouting${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: storeId(),
        permissions: [Permissions.SETTINGS_VIEW]
      })
      const as = api(app, reader, ctx.storeA2)

      const read = await as.get(ApiRoutes.settings.routing)
      const readOne = await as.get(ApiRoutes.settings.routingRuleById(made.id))
      const writes = [
        await as.post(ApiRoutes.settings.routing).send(body()),
        await as.patch(ApiRoutes.settings.routingRuleById(made.id)).send({ name: 'x' }),
        await as.delete(ApiRoutes.settings.routingRuleById(made.id)),
        await as.patch(ApiRoutes.settings.routingOrder).send({ ruleIds: [made.id] })
      ]

      expect([read.status, readOne.status]).toEqual([OK, OK])
      expect(writes.map(answer => answer.status)).toEqual(Array(4).fill(FORBIDDEN))
      expect(await owner.routingRule.count({ where: { storeId: storeId() } })).toBe(1)
    })

    it('lets who manages routing change it, with all four routes, and not read the settings', async () => {
      const made = await createRoutingRule(owner, { storeId: storeId(), name: 'managed' })
      const other = await createRoutingRule(owner, { storeId: storeId(), name: 'other' })
      const manager = await actorWithPermissions(owner, app, {
        prefix,
        name: `managerRouting${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: storeId(),
        permissions: [Permissions.SETTINGS_MANAGE_ROUTING]
      })
      const as = api(app, manager, ctx.storeA2)

      const read = await as.get(ApiRoutes.settings.routing)
      const written = await as.post(ApiRoutes.settings.routing).send(body())
      const changed = await as
        .patch(ApiRoutes.settings.routingRuleById(made.id))
        .send({ name: 'renamed' })
      const ordered = await as
        .patch(ApiRoutes.settings.routingOrder)
        .send({ ruleIds: [other.id, made.id, (written.body as RuleBody).id] })
      const removed = await as.delete(ApiRoutes.settings.routingRuleById(made.id))

      expect(read.status).toBe(FORBIDDEN)
      expect([written.status, changed.status, ordered.status, removed.status]).toEqual([
        CREATED,
        OK,
        OK,
        NO_CONTENT
      ])
    })

    it('does not let the roles of the inbox into the routing', async () => {
      const as = api(app, ana, ctx.storeA2)

      const read = await as.get(ApiRoutes.settings.routing)
      const written = await as.post(ApiRoutes.settings.routing).send(body())

      expect([read.status, written.status]).toEqual([FORBIDDEN, FORBIDDEN])
    })
  })

  // The rules are applied by the inbound pipeline (Step 2.6) with the service: there is no route
  describe('applying them to a new conversation', () => {
    const routing = () => app.get(RoutingService, { strict: false })
    // A conversation of a customer of the store, as the pipeline would have just made it
    const arriving = async (extra: Partial<Parameters<typeof createConversationOf>[1]> = {}) =>
      createConversationOf(owner, {
        storeId: storeId(),
        channelType: ChannelType.WHATSAPP,
        ...extra
      })
    // The channel and the customer are the conversation's: the context is what was said, and when
    const apply = (
      made: { id: string },
      context: { text?: string | null; receivedAt?: Date } = {}
    ) =>
      routing().apply(storeId(), made.id, {
        text: context.text === undefined ? 'hola' : context.text,
        receivedAt: context.receivedAt ?? new Date()
      })
    const assignedTo = async (id: string) =>
      (await owner.conversation.findUniqueOrThrow({ where: { id } })).assignedTo
    const assignTo = (userId: string) => ({ type: ASSIGN_USER, userIds: [userId] })
    // What removing a member leaves in the membership: the status and the date
    const revoke = (userIds: string[]) =>
      owner.membership.updateMany({
        where: { userId: { in: userIds }, storeId: storeId() },
        data: { status: MembershipStatus.REVOKED, revokedAt: new Date() }
      })

    it('leaves it for the team when there are no rules or none matches', async () => {
      const made = await arriving()
      await createRoutingRule(owner, {
        storeId: storeId(),
        conditions: { channelTypes: [ChannelType.WEB_WIDGET] },
        action: assignTo(ana.id)
      })

      const outcome = await apply(made)

      expect(outcome).toEqual({ ruleId: null, assignedTo: null })
      expect(await assignedTo(made.id)).toBeNull()
    })

    it('gives it to the person of the first rule that matches', async () => {
      const made = await arriving()
      const rule = await createRoutingRule(owner, { storeId: storeId(), action: assignTo(ana.id) })

      const outcome = await apply(made)

      expect(outcome).toEqual({ ruleId: rule.id, assignedTo: ana.id })
      expect(await assignedTo(made.id)).toBe(ana.id)
    })

    it('tries the rules by priority, whatever order they were made in', async () => {
      const made = await arriving()
      await createRoutingRule(owner, { storeId: storeId(), priority: 9, action: assignTo(beto.id) })
      const first = await createRoutingRule(owner, {
        storeId: storeId(),
        priority: 3,
        action: assignTo(ana.id)
      })

      const outcome = await apply(made)

      expect(outcome.ruleId).toBe(first.id)
      expect(await assignedTo(made.id)).toBe(ana.id)
    })

    it('skips the rules that are off', async () => {
      const made = await arriving()
      await createRoutingRule(owner, {
        storeId: storeId(),
        enabled: false,
        action: assignTo(ana.id)
      })
      const on = await createRoutingRule(owner, { storeId: storeId(), action: assignTo(beto.id) })

      const outcome = await apply(made)

      expect(outcome).toEqual({ ruleId: on.id, assignedTo: beto.id })
    })

    it('stops at a rule that leaves it unassigned, and does not try the next ones', async () => {
      const made = await arriving()
      const stop = await createRoutingRule(owner, {
        storeId: storeId(),
        action: { type: UNASSIGNED }
      })
      await createRoutingRule(owner, { storeId: storeId(), action: assignTo(ana.id) })

      const outcome = await apply(made)

      expect(outcome).toEqual({ ruleId: stop.id, assignedTo: null })
      expect(await assignedTo(made.id)).toBeNull()
    })

    describe('by channel', () => {
      it('matches any of the channels listed', async () => {
        const rule = await createRoutingRule(owner, {
          storeId: storeId(),
          conditions: { channelTypes: [ChannelType.INSTAGRAM, ChannelType.WHATSAPP] },
          action: assignTo(ana.id)
        })

        const whatsapp = await apply(await arriving())
        const widget = await apply(await arriving({ channelType: ChannelType.WEB_WIDGET }))

        expect(whatsapp.ruleId).toBe(rule.id)
        expect(widget.ruleId).toBeNull()
      })
    })

    describe('by words', () => {
      const withKeywords = (keywords: string[]) =>
        createRoutingRule(owner, {
          storeId: storeId(),
          conditions: { keywords },
          action: assignTo(ana.id)
        })

      it.each([
        ['the word as it is', 'Quiero saber el precio', ['precio']],
        ['another case', 'PRECIO por favor', ['precio']],
        ['the same word without its accent', 'cuanto cuesta el envio?', ['Envío']],
        ['the word with an accent the keyword lacks', 'hola, ¿cuál es el envío?', ['envio']],
        ['any of the words', 'una devolución', ['precio', 'devolucion']],
        ['a part of a word', 'preciosa', ['precio']]
      ])('matches %s', async (_name, text, keywords) => {
        const rule = await withKeywords(keywords)

        const outcome = await apply(await arriving(), { text })

        expect(outcome.ruleId).toBe(rule.id)
      })

      it.each([
        ['none of the words', 'buenos días', ['precio']],
        ['a message with no text', null, ['precio']],
        ['an empty message', '', ['precio']]
      ])('does not match %s', async (_name, text, keywords) => {
        await withKeywords(keywords)

        const outcome = await apply(await arriving(), { text })

        expect(outcome.ruleId).toBeNull()
      })

      it('finds a word that has an invisible character put inside it', async () => {
        const rule = await withKeywords(['refund'])

        const outcome = await apply(await arriving(), { text: 'I want a re\u200bfund' })

        expect(outcome.ruleId).toBe(rule.id)
      })

      it('does not look past the part of the text that is searched', async () => {
        await withKeywords(['precio'])
        const text = `${'a'.repeat(RoutingLimits.KEYWORD_SEARCH_MAX_LENGTH)} precio`

        const outcome = await apply(await arriving(), { text })

        expect(outcome.ruleId).toBeNull()
      })
    })

    describe('by the tags of the customer', () => {
      it('matches a customer who has any of the tags', async () => {
        const vip = await createTag(owner, { storeId: storeId() })
        const other = await createTag(owner, { storeId: storeId() })
        const made = await arriving()
        await owner.customer.update({
          where: { id: made.customerId },
          data: { tags: { connect: { id: vip.id } } }
        })
        const rule = await createRoutingRule(owner, {
          storeId: storeId(),
          conditions: { tagIds: [other.id, vip.id] },
          action: assignTo(ana.id)
        })

        const outcome = await apply(made)

        expect(outcome.ruleId).toBe(rule.id)
      })

      it('does not match a new customer, who has no tags, and goes on to the next rule', async () => {
        const vip = await createTag(owner, { storeId: storeId() })
        await createRoutingRule(owner, {
          storeId: storeId(),
          conditions: { tagIds: [vip.id] },
          action: assignTo(ana.id)
        })
        const fallback = await createRoutingRule(owner, {
          storeId: storeId(),
          action: assignTo(beto.id)
        })

        const outcome = await apply(await arriving())

        expect(outcome).toEqual({ ruleId: fallback.id, assignedTo: beto.id })
      })

      it('does not read the tags of another customer', async () => {
        const vip = await createTag(owner, { storeId: storeId() })
        const tagged = await createCustomer(owner, { storeId: storeId() })
        await owner.customer.update({
          where: { id: tagged.id },
          data: { tags: { connect: { id: vip.id } } }
        })
        await createRoutingRule(owner, {
          storeId: storeId(),
          conditions: { tagIds: [vip.id] },
          action: assignTo(ana.id)
        })

        const outcome = await apply(await arriving())

        expect(outcome.ruleId).toBeNull()
      })
    })

    describe('outside business hours', () => {
      const schedule = {
        mon: [{ from: '09:00', to: '18:00' }],
        tue: [],
        wed: [],
        thu: [],
        fri: [],
        sat: [],
        sun: []
      }
      const setHours = (timezone: string) =>
        owner.businessHours.upsert({
          where: { storeId: storeId() },
          create: { storeId: storeId(), timezone, schedule },
          update: { timezone, schedule }
        })
      // 2026-03-02 is a Monday
      const inside = new Date('2026-03-02T15:00:00Z')
      const outside = new Date('2026-03-02T23:00:00Z')

      afterEach(async () => {
        await owner.businessHours.deleteMany({ where: { storeId: storeId() } })
      })

      it('matches only when the store is closed, on the clock of its timezone', async () => {
        await setHours('UTC')
        const rule = await createRoutingRule(owner, {
          storeId: storeId(),
          conditions: { outsideBusinessHours: true },
          action: assignTo(ana.id)
        })

        const during = await apply(await arriving(), { receivedAt: inside })
        const after = await apply(await arriving(), { receivedAt: outside })

        expect(during.ruleId).toBeNull()
        expect(after.ruleId).toBe(rule.id)
      })

      it('reads the hours in the timezone of the store', async () => {
        await setHours('Asia/Tokyo')
        const rule = await createRoutingRule(owner, {
          storeId: storeId(),
          conditions: { outsideBusinessHours: true },
          action: assignTo(ana.id)
        })

        // 15:00 UTC is midnight of Tuesday in Tokyo: closed there, though open in UTC
        const outcome = await apply(await arriving(), { receivedAt: inside })

        expect(outcome.ruleId).toBe(rule.id)
      })

      it.each([
        [
          'a schedule the api would not have written',
          { timezone: 'UTC', schedule: { mon: 'always' } }
        ],
        ['a timezone the runtime does not know', { timezone: 'Mars/Olympus', schedule }]
      ])(
        'does not stop the message for %s: it is as if there were no hours',
        async (_name, row) => {
          await owner.businessHours.upsert({
            where: { storeId: storeId() },
            create: { storeId: storeId(), ...row },
            update: row
          })
          await createRoutingRule(owner, {
            storeId: storeId(),
            conditions: { outsideBusinessHours: true },
            action: assignTo(ana.id)
          })
          const next = await createRoutingRule(owner, {
            storeId: storeId(),
            action: assignTo(beto.id)
          })

          const outcome = await apply(await arriving(), { receivedAt: outside })

          expect(outcome).toEqual({ ruleId: next.id, assignedTo: beto.id })
        }
      )

      it('does not match a store that never set its hours: there is no outside of nothing', async () => {
        await createRoutingRule(owner, {
          storeId: storeId(),
          conditions: { outsideBusinessHours: true },
          action: assignTo(ana.id)
        })

        const outcome = await apply(await arriving(), { receivedAt: outside })

        expect(outcome.ruleId).toBeNull()
      })
    })

    it('needs every condition of a rule, not one', async () => {
      await createRoutingRule(owner, {
        storeId: storeId(),
        conditions: { channelTypes: [ChannelType.WHATSAPP], keywords: ['precio'] },
        action: assignTo(ana.id)
      })

      const right = await apply(await arriving(), { text: 'el precio?' })
      const wrongWords = await apply(await arriving(), { text: 'hola' })
      const wrongChannel = await apply(await arriving({ channelType: ChannelType.WEB_WIDGET }), {
        text: 'el precio?'
      })

      expect(right.assignedTo).toBe(ana.id)
      expect([wrongWords.ruleId, wrongChannel.ruleId]).toEqual([null, null])
    })

    describe('the person of a rule', () => {
      it('is not given the conversation if they left, and the next rule decides', async () => {
        const gone = await createActor(owner, app, {
          prefix,
          name: `goneRouting${randomUUID().slice(0, 6)}`,
          organizationId: ctx.orgA.id,
          storeId: storeId(),
          roleId: ctx.roleIds[RoleNames.AGENT]
        })
        await createRoutingRule(owner, {
          storeId: storeId(),
          action: assignTo(gone.id)
        })
        const next = await createRoutingRule(owner, {
          storeId: storeId(),
          action: assignTo(ana.id)
        })
        await revoke([gone.id])
        const made = await arriving()

        const outcome = await apply(made)

        expect(outcome).toEqual({ ruleId: next.id, assignedTo: ana.id })
        expect(await assignedTo(made.id)).toBe(ana.id)
      })

      it('is not given it if their membership has a date of revocation, whatever its status', async () => {
        const member = await createActor(owner, app, {
          prefix,
          name: `dateOnly${randomUUID().slice(0, 6)}`,
          organizationId: ctx.orgA.id,
          storeId: storeId(),
          roleId: ctx.roleIds[RoleNames.AGENT]
        })
        await createRoutingRule(owner, { storeId: storeId(), action: assignTo(member.id) })
        await owner.membership.updateMany({
          where: { userId: member.id, storeId: storeId() },
          data: { revokedAt: new Date() }
        })

        const outcome = await apply(await arriving())

        expect(outcome.assignedTo).toBeNull()
      })

      it('is not given it if their role no longer sees conversations', async () => {
        const blind = await actorWithPermissions(owner, app, {
          prefix,
          name: `blindApply${randomUUID().slice(0, 6)}`,
          organizationId: ctx.orgA.id,
          storeId: storeId(),
          permissions: [Permissions.TEAM_VIEW]
        })
        await createRoutingRule(owner, { storeId: storeId(), action: assignTo(blind.id) })
        const made = await arriving()

        const outcome = await apply(made)

        expect(outcome.assignedTo).toBeNull()
      })
    })

    describe('a round robin', () => {
      const robin = (...users: string[]) =>
        createRoutingRule(owner, {
          storeId: storeId(),
          action: { type: ROUND_ROBIN, userIds: users }
        })
      const load = async (userId: string, count: number, status = ConversationStatus.OPEN) => {
        for (let index = 0; index < count; index += 1) {
          await arriving({ assignedTo: userId, status })
        }
      }

      it('gives it to the one with the fewest conversations to work', async () => {
        await load(ana.id, 3)
        await load(beto.id, 1)
        await load(carla.id, 2)
        await robin(ana.id, beto.id, carla.id)
        const made = await arriving()

        const outcome = await apply(made)

        expect(outcome.assignedTo).toBe(beto.id)
      })

      it('spreads a run of conversations over the people of the list', async () => {
        await robin(ana.id, beto.id, carla.id)
        const given: string[] = []

        for (let index = 0; index < 6; index += 1) {
          const outcome = await apply(await arriving())
          given.push(outcome.assignedTo ?? 'nobody')
        }

        const counts = given.reduce<Record<string, number>>(
          (all, id) => ({ ...all, [id]: (all[id] ?? 0) + 1 }),
          {}
        )
        expect(counts).toEqual({ [ana.id]: 2, [beto.id]: 2, [carla.id]: 2 })
      })

      it('counts the conversations that are open or pending, and not the closed ones', async () => {
        // The one with the lowest id would win a tie: the pending conversation is given to it, so
        // that only counting it makes the other one win
        const [low, high] = [ana.id, beto.id].toSorted()
        await load(low ?? '', 1, ConversationStatus.PENDING)
        await load(high ?? '', 2, ConversationStatus.RESOLVED)
        await load(high ?? '', 1, ConversationStatus.ARCHIVED)
        await robin(ana.id, beto.id)

        const outcome = await apply(await arriving())

        expect(outcome.assignedTo).toBe(high)
      })

      it('breaks a tie with the lowest id, wherever it is in the list', async () => {
        const [lowest, middle, highest] = [ana.id, beto.id, carla.id].toSorted()
        await robin(highest ?? '', lowest ?? '', middle ?? '')

        const outcomes = [await apply(await arriving())]
        // Nothing is left over from the first: the answer is the same for a conversation of its own
        await owner.conversation.deleteMany({ where: { storeId: storeId() } })
        outcomes.push(await apply(await arriving()))

        expect(outcomes.map(outcome => outcome.assignedTo)).toEqual([lowest, lowest])
      })

      it('does not count the conversations of the other stores', async () => {
        await createConversationOf(owner, { storeId: ctx.storeB.id, assignedTo: ana.id })
        await createConversationOf(owner, { storeId: ctx.storeA.id, assignedTo: ana.id })
        await load(beto.id, 1)
        await robin(ana.id, beto.id)

        const outcome = await apply(await arriving())

        expect(outcome.assignedTo).toBe(ana.id)
      })

      it('gives a run of conversations that arrive together to different people', async () => {
        await robin(ana.id, beto.id, carla.id)
        const made = await Promise.all(Array.from({ length: 6 }, () => arriving()))

        const outcomes = await Promise.all(made.map(conversation => apply(conversation)))

        const counts = outcomes.reduce<Record<string, number>>(
          (all, outcome) => ({
            ...all,
            [outcome.assignedTo ?? 'nobody']: (all[outcome.assignedTo ?? 'nobody'] ?? 0) + 1
          }),
          {}
        )
        expect(counts).toEqual({ [ana.id]: 2, [beto.id]: 2, [carla.id]: 2 })
      })

      it('goes on to the next rule when everybody of the list left', async () => {
        const left = await createActor(owner, app, {
          prefix,
          name: `allGone${randomUUID().slice(0, 6)}`,
          organizationId: ctx.orgA.id,
          storeId: storeId(),
          roleId: ctx.roleIds[RoleNames.AGENT]
        })
        const other = await createActor(owner, app, {
          prefix,
          name: `allGone2${randomUUID().slice(0, 6)}`,
          organizationId: ctx.orgA.id,
          storeId: storeId(),
          roleId: ctx.roleIds[RoleNames.AGENT]
        })
        await robin(left.id, other.id)
        const fallback = await createRoutingRule(owner, {
          storeId: storeId(),
          action: assignTo(carla.id)
        })
        await revoke([left.id, other.id])

        const outcome = await apply(await arriving())

        expect(outcome).toEqual({ ruleId: fallback.id, assignedTo: carla.id })
      })

      it('skips who left and leaves it unassigned when nobody is left', async () => {
        const members = await Promise.all(
          ['one', 'two', 'three'].map(name =>
            createActor(owner, app, {
              prefix,
              name: `leftRouting${name}${randomUUID().slice(0, 6)}`,
              organizationId: ctx.orgA.id,
              storeId: storeId(),
              roleId: ctx.roleIds[RoleNames.AGENT]
            })
          )
        )
        const [first, second, stays] = members.map(member => member.id)
        await robin(first ?? '', second ?? '', stays ?? '')
        await revoke([first ?? '', second ?? ''])

        const onlyOneLeft = await apply(await arriving())
        await revoke([stays ?? ''])
        const nobody = await apply(await arriving())

        expect(onlyOneLeft.assignedTo).toBe(stays)
        expect(nobody).toEqual({ ruleId: null, assignedTo: null })
      })
    })

    describe('a conversation that is not new', () => {
      it('is left with whoever has it', async () => {
        const made = await arriving({ assignedTo: beto.id })
        await createRoutingRule(owner, { storeId: storeId(), action: assignTo(ana.id) })

        const outcome = await apply(made)

        expect(outcome).toEqual({ ruleId: null, assignedTo: beto.id })
        expect(await assignedTo(made.id)).toBe(beto.id)
      })

      it('is never taken from a person who has it: giving a conversation is atomic', async () => {
        const made = await arriving({ assignedTo: beto.id })
        const conversations = app.get(ConversationsService, { strict: false })
        const prisma = app.get(PrismaService, { strict: false })

        const given = await prisma.transaction(tx =>
          conversations.assignIfFree(tx, storeId(), made.id, ana.id)
        )

        expect(given).toBe(false)
        expect(await assignedTo(made.id)).toBe(beto.id)
      })

      it.each([ConversationStatus.ARCHIVED, ConversationStatus.SPAM])(
        'is not given to someone who could not see it once it is %s',
        async status => {
          const made = await arriving({ status })
          await createRoutingRule(owner, { storeId: storeId(), action: assignTo(ana.id) })

          const outcome = await apply(made)

          expect(outcome.assignedTo).toBeNull()
          expect(await assignedTo(made.id)).toBeNull()
        }
      )

      it('does not exist in another store', async () => {
        const foreign = await createConversationOf(owner, { storeId: ctx.storeB.id })

        await expect(
          routing().apply(storeId(), foreign.id, { text: 'hola', receivedAt: new Date() })
        ).rejects.toMatchObject({ code: ErrorCodes.RESOURCE_NOT_FOUND })
      })
    })

    it('does not use the rules of another store', async () => {
      await createRoutingRule(owner, { storeId: ctx.storeB.id, action: assignTo(ctx.adminB.id) })
      const made = await arriving()

      const outcome = await apply(made)

      expect(outcome).toEqual({ ruleId: null, assignedTo: null })
    })

    it('skips a rule whose stored shape is not one the api writes, and goes on', async () => {
      await createRoutingRule(owner, {
        storeId: storeId(),
        conditions: { intents: ['refund'] },
        action: assignTo(beto.id)
      })
      await createRoutingRule(owner, {
        storeId: storeId(),
        conditions: {},
        action: { type: 'teleport' }
      })
      const good = await createRoutingRule(owner, { storeId: storeId(), action: assignTo(ana.id) })

      const outcome = await apply(await arriving())

      expect(outcome).toEqual({ ruleId: good.id, assignedTo: ana.id })
    })
  })
})
