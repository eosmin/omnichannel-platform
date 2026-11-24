import type { MessageView } from '@platform/api-client'

type AnyFile = MessageView['media'][number]

// A file the reader may see: the api takes the name, the type and the size out for a person without `media:view`
// (BAN-R-meta), and such a file is drawn as a closed attachment, never as a picture, a player or a link.
export type ViewableFile = AnyFile & { filename: string; contentType: string; fileSize: number }

export function isViewableFile(file: AnyFile): file is ViewableFile {
  return file.filename !== null && file.contentType !== null && file.fileSize !== null
}

export function viewableFilesOf(files: readonly AnyFile[]): ViewableFile[] {
  return files.filter(isViewableFile)
}
