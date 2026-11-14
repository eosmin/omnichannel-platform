'use client'

import { Plus, Truck } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { CarrierConnectionView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { CarrierConnectionStatus } from '@platform/core/domain'

import { NO_FEE_SETTINGS } from '../../lib/settings/carriers-form'
import { useCarrierConnections, useCarrierRegistry } from '../../lib/settings/use-carriers'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'

import { CarrierCard } from './carrier-card'
import { CarrierConnectDialog } from './carrier-connect-dialog'
import { CarrierRulesDialog } from './carrier-rules-dialog'
import { CarrierSecretDialog } from './carrier-secret-dialog'
import { CarrierStatusMapping } from './carrier-status-mapping'
import { LoadFailed, PageLoading } from './states'

const Sections = { CONNECTIONS: 'connections', MAPPING: 'mapping' } as const
type Section = (typeof Sections)[keyof typeof Sections]

// What the page shows once a secret is made: kept in memory for the dialog only
interface SecretToShow {
  name: string
  secret: string
  webhookUrl: string | null
}

// Settings → Store → Carriers (TDD_17 §6, §4.17): the connections of the store, and the mapping of each connection's
// status codes. The page knows no carrier: what can be connected is the registry, and what a connection can do is what it
// declares.
export function CarriersPanel(): ReactElement {
  const t = useTranslations('settings.carriers')
  const { storeId, can } = useStore()
  const connections = useCarrierConnections(storeId)
  const registry = useCarrierRegistry(storeId)
  const [section, setSection] = useState<Section>(Sections.CONNECTIONS)
  const [showPast, setShowPast] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [secret, setSecret] = useState<SecretToShow | null>(null)
  const canManage = can(ClientPermissions.SETTINGS_MANAGE_CARRIERS)

  if (connections.isError) {
    return <LoadFailed error={connections.error} onRetry={() => void connections.refetch()} />
  }
  if (connections.data === undefined) return <PageLoading />

  const all = connections.data
  const isPast = (connection: CarrierConnectionView): boolean =>
    connection.status === String(CarrierConnectionStatus.DISABLED)
  const live = all.filter(connection => !isPast(connection))
  const past = all.filter(isPast)
  const toEdit = editing === null ? undefined : all.find(connection => connection.id === editing)

  return (
    <section className="flex max-w-3xl flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        {canManage && section === Sections.CONNECTIONS ? (
          <Button
            type="button"
            disabled={registry.data === undefined || registry.data.length === 0}
            onClick={() => setConnecting(true)}
          >
            <Plus aria-hidden />
            {t('add')}
          </Button>
        ) : null}
      </header>

      <Tabs value={section} onValueChange={value => setSection(value as Section)}>
        <TabsList aria-label={t('sections.label')}>
          <TabsTrigger value={Sections.CONNECTIONS}>{t('sections.connections')}</TabsTrigger>
          <TabsTrigger value={Sections.MAPPING}>{t('sections.mapping')}</TabsTrigger>
        </TabsList>
      </Tabs>

      {section === Sections.CONNECTIONS ? (
        <>
          {registry.isError ? (
            <p role="alert" className="text-destructive text-sm">
              {t('registryFailed')}
            </p>
          ) : null}
          {registry.data !== undefined && registry.data.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('noneAvailable')}</p>
          ) : null}
          {live.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
              <Truck aria-hidden className="text-muted-foreground size-8" />
              <h2 className="text-base font-semibold">{t('empty.title')}</h2>
              <p className="text-muted-foreground max-w-sm text-sm">{t('empty.body')}</p>
            </div>
          ) : (
            <ul aria-label={t('listLabel')} className="flex flex-col gap-3">
              {live.map(connection => (
                <CarrierCard
                  key={connection.id}
                  connection={connection}
                  onEdit={item => setEditing(item.id)}
                  onSecret={(item, value) =>
                    setSecret({
                      name: item.displayName,
                      secret: value,
                      webhookUrl: item.webhookUrl
                    })
                  }
                />
              ))}
            </ul>
          )}
          {past.length === 0 ? null : (
            <div className="flex flex-col gap-3">
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-expanded={showPast}
                  onClick={() => setShowPast(shown => !shown)}
                >
                  {showPast
                    ? t('past.hide', { count: past.length })
                    : t('past.show', { count: past.length })}
                </Button>
              </div>
              {showPast ? (
                <>
                  <p className="text-muted-foreground text-sm">{t('past.hint')}</p>
                  <ul aria-label={t('past.title')} className="flex flex-col gap-3">
                    {past.map(connection => (
                      <CarrierCard
                        key={connection.id}
                        connection={connection}
                        onEdit={item => setEditing(item.id)}
                        onSecret={() => undefined}
                      />
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          )}
        </>
      ) : (
        <MappingSection connections={live} />
      )}

      {connecting && registry.data !== undefined ? (
        <CarrierConnectDialog
          registry={registry.data}
          onConnected={made => {
            setConnecting(false)
            // The secret comes once, in this answer: it is handed to the dialog that shows it
            if (made.webhookSecret !== null) {
              setSecret({
                name: made.displayName,
                secret: made.webhookSecret,
                webhookUrl: made.webhookUrl
              })
            }
          }}
          onClose={() => setConnecting(false)}
        />
      ) : null}
      {toEdit === undefined || registry.isPending ? null : (
        <CarrierRulesDialog
          connection={toEdit}
          // A registry that cannot be read leaves the free JSON box: the connection can still be edited
          connectFields={
            registry.data?.find(entry => entry.id === toEdit.carrierId)?.connectFields ?? []
          }
          feeSettings={
            registry.data?.find(entry => entry.id === toEdit.carrierId)?.feeSettings ??
            NO_FEE_SETTINGS
          }
          onClose={() => setEditing(null)}
        />
      )}
      {secret === null ? null : (
        <CarrierSecretDialog
          connectionName={secret.name}
          secret={secret.secret}
          webhookUrl={secret.webhookUrl}
          onClose={() => setSecret(null)}
        />
      )}
    </section>
  )
}

function MappingSection({
  connections
}: {
  connections: readonly CarrierConnectionView[]
}): ReactElement {
  const t = useTranslations('settings.carriers.mapping')
  const [chosen, setChosen] = useState<string | null>(null)
  if (connections.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('noConnections')}</p>
  }
  const connection = connections.find(item => item.id === chosen) ?? connections[0]
  if (connection === undefined) return <></>
  return (
    <div className="flex flex-col gap-4">
      {connections.length > 1 ? (
        <div className="grid max-w-sm gap-1.5">
          <label htmlFor="carrier-mapping-connection" className="text-sm font-medium">
            {t('connection')}
          </label>
          <select
            id="carrier-mapping-connection"
            value={connection.id}
            onChange={event => setChosen(event.target.value)}
            className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          >
            {connections.map(item => (
              <option key={item.id} value={item.id}>
                {item.displayName}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <CarrierStatusMapping key={connection.id} connection={connection} />
    </div>
  )
}
