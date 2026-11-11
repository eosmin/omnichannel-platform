'use client'

import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useMemo, useState } from 'react'

import type { WarehouseDetailView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { WarehouseDialog } from '../../components/warehouses/warehouse-dialog'
import type { LinkableStore } from '../../components/warehouses/warehouse-stores-editor'
import { useOrganizationStores } from '../../lib/settings/use-settings-data'
import { useProfile } from '../../lib/use-profile'
import { useWarehouses } from '../../lib/warehouses/use-warehouses'

// Organization → Warehouses (TDD_16 §6, TDD_09 §16): the warehouses of the organization, the stores each one serves
// and the order each store reserves from them. Opening needs inventory:view; changing needs org:manage_warehouses
// (the api checks both on every call).
export function WarehousesPage(): ReactElement {
  const { can } = useStore()
  return can(ClientPermissions.INVENTORY_VIEW) ? (
    <Warehouses />
  ) : (
    <PermissionDenied permission={ClientPermissions.INVENTORY_VIEW} />
  )
}

// The stores a warehouse may be linked to: all of the organization for who manages stores, otherwise the ones the
// person belongs to. A store a warehouse already serves is never lost from the editor, whoever opens it (the list
// of links is saved whole, and it comes with the names).
function useLinkableStores(): LinkableStore[] {
  const { storeId, can } = useStore()
  const canManageStores = can(ClientPermissions.ORG_MANAGE_STORES)
  const organizationStores = useOrganizationStores(storeId, canManageStores)
  const profile = useProfile()
  return useMemo(() => {
    if (canManageStores) {
      return (organizationStores.data ?? []).map(store => ({ id: store.id, name: store.name }))
    }
    return (profile.data?.memberships ?? []).map(item => ({
      id: item.storeId,
      name: item.storeName
    }))
  }, [canManageStores, organizationStores.data, profile.data])
}

function Warehouses(): ReactElement {
  const t = useTranslations('warehouses')
  const { storeId, can } = useStore()
  const canEdit = can(ClientPermissions.ORG_MANAGE_WAREHOUSES)
  const warehouses = useWarehouses(storeId)
  const stores = useLinkableStores()
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  if (warehouses.isError) {
    return <LoadFailed error={warehouses.error} onRetry={() => void warehouses.refetch()} />
  }
  if (warehouses.data === undefined) return <PageLoading />
  const editing = warehouses.data.find(item => item.id === editingId) ?? null
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        {canEdit ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {t('new')}
          </Button>
        ) : null}
      </header>
      {warehouses.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {warehouses.data.map(warehouse => (
            <WarehouseRow
              key={warehouse.id}
              warehouse={warehouse}
              onOpen={() => setEditingId(warehouse.id)}
            />
          ))}
        </ul>
      )}
      <WarehouseDialog
        warehouse={null}
        open={creating}
        onOpenChange={setCreating}
        stores={stores}
        warehouses={warehouses.data}
      />
      <WarehouseDialog
        warehouse={editing}
        open={editing !== null}
        onOpenChange={open => {
          if (!open) setEditingId(null)
        }}
        stores={stores}
        warehouses={warehouses.data}
      />
    </section>
  )
}

function WarehouseRow({
  warehouse,
  onOpen
}: {
  warehouse: WarehouseDetailView
  onOpen: () => void
}): ReactElement {
  const t = useTranslations('warehouses')
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="hover:bg-accent flex w-full flex-col gap-1 px-4 py-3 text-left pointer-coarse:min-h-12"
      >
        <span className="flex items-center gap-2">
          <span className="font-medium">{warehouse.name}</span>
          <span className="text-muted-foreground text-xs">{warehouse.code}</span>
          {warehouse.active ? null : (
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
              {t('inactive')}
            </span>
          )}
        </span>
        <span className="text-muted-foreground text-sm">
          {warehouse.stores.length === 0
            ? t('noStores')
            : t('servesStores', {
                count: warehouse.stores.length,
                stores: warehouse.stores.map(link => link.storeName).join(', ')
              })}
        </span>
      </button>
    </li>
  )
}
