import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'
import { z } from 'zod'

import {
  CONNECTION_ROW_SELECT,
  ChannelContextFactory,
  errorName,
  providerText,
  withTimeout
} from '@platform/channels/connections'
import { Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import {
  ChannelConnectionStatus,
  isInstallationActive,
  MessageLimits,
  type MessageType,
  MisleadingTextPattern,
  OfActiveInstallation,
  OutboundLimits,
  type TemplateStatus,
  TemplateStatuses
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import {
  canSee,
  type CreateMessageBody,
  invalidInput,
  type RenderedTemplate,
  requireAnyPermission,
  type Viewer
} from '@platform/core/messaging'
import { PluginRegistry } from '@platform/plugins/runtime'
import { ChannelCapability } from '@platform/plugins/sdk'

export interface TemplateView {
  name: string
  language: string
  status: TemplateStatus
  body: string
}

// A plugin may be a third party's: what it lists is checked before it reaches a browser, and its text
// is cleaned as any text that comes from a provider
const templateSchema = z.object({
  name: z.string().min(1).max(MessageLimits.TEMPLATE_NAME_MAX_LENGTH),
  language: z.string().min(1).max(MessageLimits.TEMPLATE_LANGUAGE_MAX_LENGTH),
  status: z.enum(TemplateStatuses),
  body: z.string().max(MessageLimits.CONTENT_MAX_LENGTH)
})

// {{1}}, {{2}}: the numbered placeholders of a template body
const PLACEHOLDER = /\{\{(\d+)\}\}/g
const ANY_PLACEHOLDER = /\{\{[^}]*\}\}/g

type TemplateBody = Extract<CreateMessageBody, { type: MessageType.TEMPLATE }>

// The templates of a connection of the store, as its plugin lists them, and the check of one before a
// message that uses it is stored. The provider is asked here and never inside a transaction.
@Injectable()
export class ChannelTemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PluginRegistry,
    private readonly contexts: ChannelContextFactory,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ChannelTemplatesService.name)
  }

  // For the composer: the connection must be of this store and of this plugin
  async list(storeId: string, pluginId: string, connectionRowId: string): Promise<TemplateView[]> {
    const row = await this.prisma.client.channelConnection.findFirst({
      where: { id: connectionRowId, storeId, pluginId, ...OfActiveInstallation },
      select: CONNECTION_ROW_SELECT
    })
    if (row === null) throw resourceNotFound('channel connection')
    return this.listOf(row)
  }

  // The template the agent chose, if it exists and the provider approved it, with its body filled in
  // with their variables. The conversation must be one the agent can see.
  async render(storeId: string, body: TemplateBody, viewer: Viewer): Promise<RenderedTemplate> {
    // Asking the provider is for who may send the template, whoever calls this
    requireAnyPermission(viewer.held, [Permissions.MESSAGES_SEND_TEMPLATE])
    const conversation = await this.prisma.client.conversation.findFirst({
      where: { id: body.conversationId, storeId },
      select: {
        status: true,
        assignedTo: true,
        channelConnection: {
          select: {
            ...CONNECTION_ROW_SELECT,
            installation: { select: { status: true, plugin: { select: { status: true } } } }
          }
        }
      }
    })
    if (conversation === null || !canSee(viewer, conversation)) {
      throw resourceNotFound('conversation')
    }
    const { installation, ...row } = conversation.channelConnection
    // A connection of an installation that is not active sends nothing, as a disconnected one
    if (!isInstallationActive(installation)) {
      throw new PlatformException(
        ErrorCodes.CHANNEL_NOT_CONNECTED,
        'the plugin is not installed in this store',
        HttpStatusCodes.CONFLICT
      )
    }
    const templates = await this.listOf(row)
    const template = templates.find(
      item => item.name === body.templateName && item.language === body.language
    )
    if (template === undefined) throw resourceNotFound('template')
    if (template.status !== TemplateStatuses.APPROVED) {
      throw new PlatformException(
        ErrorCodes.CHANNEL_TEMPLATE_NOT_APPROVED,
        'the template is not approved',
        HttpStatusCodes.CONFLICT,
        { status: template.status }
      )
    }
    return { content: fill(template.body, body.variables) }
  }

  private async listOf(
    row: Parameters<ChannelContextFactory['contextFor']>[0]
  ): Promise<TemplateView[]> {
    if (row.status === String(ChannelConnectionStatus.DISCONNECTED)) {
      throw new PlatformException(
        ErrorCodes.CHANNEL_NOT_CONNECTED,
        'the connection is disconnected',
        HttpStatusCodes.CONFLICT
      )
    }
    const plugin = this.registry.find(row.pluginId)
    if (
      plugin?.listTemplates === undefined ||
      !this.registry.hasCapability(row.pluginId, ChannelCapability.TEMPLATES)
    ) {
      throw new PlatformException(
        ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED,
        'the channel has no templates',
        HttpStatusCodes.CONFLICT
      )
    }
    try {
      const raw = z
        .array(z.unknown())
        .parse(
          await withTimeout(
            plugin.listTemplates(this.contexts.contextFor(row)),
            OutboundLimits.SEND_TIMEOUT_MS
          )
        )
      // One template the plugin got wrong is left out, not a reason to list none
      const listed = raw.flatMap(item => {
        const parsed = templateSchema.safeParse(item)
        return parsed.success ? [parsed.data] : []
      })
      if (listed.length < raw.length) {
        this.logger.warn(
          { pluginId: row.pluginId, dropped: raw.length - listed.length },
          'templates with an invalid shape were left out'
        )
      }
      return listed.map(item => ({
        ...item,
        name: providerText(item.name, MessageLimits.TEMPLATE_NAME_MAX_LENGTH),
        language: providerText(item.language, MessageLimits.TEMPLATE_LANGUAGE_MAX_LENGTH),
        // Line breaks are part of a template body: only the controls that mislead are taken out
        body: item.body.replace(new RegExp(MisleadingTextPattern, 'gu'), '')
      }))
    } catch (error) {
      // Only the name: the message of an error from a provider may hold a token
      this.logger.warn(
        { pluginId: row.pluginId, errorName: errorName(error) },
        'listing templates failed'
      )
      throw new PlatformException(
        ErrorCodes.CHANNEL_MESSAGE_FAILED,
        'the channel did not list its templates',
        HttpStatusCodes.INTERNAL_SERVER_ERROR
      )
    }
  }
}

// Every numbered placeholder takes the variable of its position; a template with more placeholders
// than values, or values the template does not use, is a request that cannot be sent as written
function fill(body: string, variables: readonly string[]): string {
  // Only numbered placeholders are filled: a body with a named one cannot be sent from here
  if ([...body.matchAll(ANY_PLACEHOLDER)].some(match => !/^\{\{\d+\}\}$/.test(match[0]))) {
    throw invalidInput('the template has placeholders that are not numbered')
  }
  const positions = [...new Set([...body.matchAll(PLACEHOLDER)].map(match => Number(match[1])))]
  // The numbering is 1..n with no gaps, and each placeholder has its value
  const numbered = positions.every(position => position >= 1 && position <= positions.length)
  if (!numbered || variables.length !== positions.length) {
    throw invalidInput('the variables do not match the placeholders of the template')
  }
  const text = body.replace(
    PLACEHOLDER,
    (_whole, position: string) => variables[Number(position) - 1] ?? ''
  )
  if (Array.from(text).length > MessageLimits.CONTENT_MAX_LENGTH) {
    throw invalidInput('the template, filled in, is longer than a message can be')
  }
  return text
}
