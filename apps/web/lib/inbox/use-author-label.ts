'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { useEffect, useMemo, useRef } from 'react'

import { QueryKeys } from '@platform/api-client'
import { AuthorType } from '@platform/core/domain'

import { useStore } from '../../components/providers/store-context'

import { useMemberDirectory } from './use-inbox-data'

// Who wrote it, as the thread names them: the customer by the name the list gives, an agent by the
// name in the directory of the store (a member that left is "Former member"), and the rest by role.
export function useAuthorLabel(
  customerName: string,
  memberIds: readonly string[]
): (type: string, id: string | null) => string {
  const t = useTranslations('inbox.thread')
  const { storeId } = useStore()
  const queryClient = useQueryClient()
  const members = useMemberDirectory(storeId)
  const asked = useRef(new Set<string>())
  const names = useMemo(
    () => new Map((members.data ?? []).map(member => [member.id, member.name])),
    [members.data]
  )
  // A member who joined after the directory was read is not in it: read it again, once for each id,
  // and say "team member" until that answer is in
  useEffect(() => {
    if (members.data === undefined) return
    const missing = memberIds.filter(id => !names.has(id) && !asked.current.has(id))
    if (missing.length === 0) return
    missing.forEach(id => asked.current.add(id))
    const key = QueryKeys.members.directory(storeId)
    void queryClient.invalidateQueries({ queryKey: key }).then(() => {
      // A read that failed answers nothing: the ids may be asked about again by the next change
      if (queryClient.getQueryState(key)?.status === 'error') {
        missing.forEach(id => asked.current.delete(id))
      }
    })
  }, [members.data, memberIds, names, queryClient, storeId])

  return (type, id) => {
    switch (type) {
      case String(AuthorType.CUSTOMER):
        return customerName
      case String(AuthorType.AGENT):
        // The directory may still be loading: say "team member" rather than "former"
        return id === null
          ? t('teamMember')
          : (names.get(id) ??
              (members.data === undefined || members.isFetching || !asked.current.has(id)
                ? t('teamMember')
                : t('formerMember')))
      case String(AuthorType.EXTERNAL):
        return t('owner')
      default:
        return t('automatic')
    }
  }
}
