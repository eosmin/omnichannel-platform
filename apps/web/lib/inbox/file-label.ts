import { MessageType } from '@platform/core/domain'
import { UNNAMED_FILE_NAME } from '@platform/core/storage'

const LABELED_TYPES: readonly string[] = [
  MessageType.IMAGE,
  MessageType.VIDEO,
  MessageType.AUDIO,
  MessageType.DOCUMENT
]

export type DisplayFileName = { kind: 'name'; name: string } | { kind: 'label'; type: string }

// What the thread calls a file. A file that came with no name is stored as "file" (a word that means
// nothing to the agent), so it is called by its kind: Audio, Imagen, Documento.
export function displayFileNameOf(filename: string, type: string): DisplayFileName {
  const name = filename.trim()
  const isUnnamed = name === '' || name === UNNAMED_FILE_NAME
  return isUnnamed && LABELED_TYPES.includes(type)
    ? { kind: 'label', type }
    : { kind: 'name', name: filename }
}
