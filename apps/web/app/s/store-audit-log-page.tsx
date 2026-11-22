'use client'

import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { AuditLogPanel } from '../../components/settings/audit-log-panel'
import { PermissionDenied } from '../../components/settings/states'

// Settings → Store → Audit log (TDD_05 §9.3). The api asks org:view_audit_log for the list, for one entry and for the file.
export function StoreAuditLogPage(): ReactElement {
  const { can, storeId } = useStore()
  return can(ClientPermissions.ORG_VIEW_AUDIT_LOG) ? (
    // A fresh panel per store: the filters typed for one store do not carry to the next
    <AuditLogPanel key={storeId} />
  ) : (
    <PermissionDenied permission={ClientPermissions.ORG_VIEW_AUDIT_LOG} />
  )
}
