'use client'

import dynamic from 'next/dynamic'

// The mapper (file reading, the preview and the mapping form) is drawn only on its own page, and downloaded when that page opens
export const LazyImportMapper = dynamic(
  () => import('../../components/remittances/import-mapper-panel'),
  { ssr: false }
)
