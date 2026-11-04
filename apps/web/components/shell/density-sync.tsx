'use client'

import { useEffect } from 'react'

import { UiDensity } from '@platform/core/domain'

// The density the person chose in their account, on the page: `compact:` classes read it from <html>.
// A value this page does not know (a newer server) is the comfortable one.
export function DensitySync({ density }: { density: string }): null {
  useEffect(() => {
    const root = document.documentElement
    root.dataset.density = density === UiDensity.COMPACT ? UiDensity.COMPACT : UiDensity.COMFORTABLE
    return () => {
      delete root.dataset.density
    }
  }, [density])
  return null
}
