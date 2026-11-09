import type { ReactElement } from 'react'

import type { MessageView } from '@platform/api-client'

import { fileCaptionOf } from '../../lib/inbox/file-caption'

type MediaFile = MessageView['media'][number]

// The text under one file of a message with several (text of an agent: React escapes it).
export function FileCaption({
  file,
  textApart = false
}: {
  file: MediaFile
  textApart?: boolean
}): ReactElement | null {
  const text = fileCaptionOf(file, textApart)
  return text === null ? null : <p className="text-sm break-words whitespace-pre-wrap">{text}</p>
}
