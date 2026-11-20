import {
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFObject
} from 'pdf-lib'

import { PdfInspection } from '@platform/core/storage'

export interface PdfInspectionResult {
  // The active names the file carries
  names: string[]
  // Why nothing can be said about the file, or null: it must be refused as well
  unreadable: string | null
}

const ACTIVE = new Set<string>(PdfInspection.ACTIVE_NAMES)
const CARRIERS = new Set<string>(PdfInspection.CARRIER_NAMES)
const CARRIER_ACTIVE = new Set<string>(PdfInspection.CARRIER_ACTIVE_NAMES)
const { UNREADABLE } = PdfInspection
const KEYS = PdfInspection.OBJECT_STREAM_KEYS

// The check ends at the first thing that cannot be proven: the reason travels up as this
class Refused extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

// An action that is a dictionary is active when it names a link or anything of the list; a destination is not
// an action; a value that is not understood is active
function actionIsActive(context: PDFContext, value: PDFObject | undefined, depth: number): boolean {
  if (value === undefined || depth > PdfInspection.CARRIER_DEPTH) return true
  const resolved = value instanceof PDFRef ? context.lookup(value) : value
  if (resolved instanceof PDFArray) return false
  if (!(resolved instanceof PDFDict)) return true
  for (const [key, entry] of resolved.entries()) {
    const name = key.decodeText()
    if (ACTIVE.has(name) || CARRIER_ACTIVE.has(name)) return true
    if (
      entry instanceof PDFName &&
      (ACTIVE.has(entry.decodeText()) || CARRIER_ACTIVE.has(entry.decodeText()))
    )
      return true
    if (entry instanceof PDFDict && actionIsActive(context, entry, depth + 1)) return true
  }
  return false
}

// A stream that looks like an object stream (/N and /First) has to say so: a reader that finds it through the
// cross reference would open it, and what it holds is never looked at here
function checkObjectStreamShape(stream: PDFStream): void {
  const dict = stream.dict
  if (!dict.has(PDFName.of(KEYS.COUNT)) || !dict.has(PDFName.of(KEYS.FIRST))) return
  if (dict.get(PDFName.of(KEYS.TYPE)) !== PDFName.of(KEYS.NAME))
    throw new Refused(UNREADABLE.UNDECLARED_OBJECT_STREAM)
}

function walk(context: PDFContext, roots: PDFObject[], found: Set<string>): void {
  const stack: PDFObject[] = [...roots]
  let visited = 0
  while (stack.length > 0) {
    const node = stack.pop() as PDFObject
    visited += 1
    if (visited > PdfInspection.MAX_NODES) throw new Refused(UNREADABLE.TOO_MANY_OBJECTS)
    if (node instanceof PDFRef) {
      // A reference to nothing is something that is hidden from this parser
      if (context.lookup(node) === undefined) throw new Refused(UNREADABLE.DANGLING_REFERENCE)
    } else if (node instanceof PDFStream) {
      checkObjectStreamShape(node)
      stack.push(node.dict)
    } else if (node instanceof PDFDict) {
      for (const [key, value] of node.entries()) {
        const name = key.decodeText()
        if (CARRIERS.has(name)) {
          if (actionIsActive(context, value, 0)) found.add(name)
        } else if (ACTIVE.has(name)) found.add(name)
        stack.push(value)
      }
    } else if (node instanceof PDFArray) {
      stack.push(...node.asArray())
    } else if (node instanceof PDFName) {
      const name = node.decodeText()
      if (ACTIVE.has(name)) found.add(name)
    }
  }
}

async function scan(bytes: Uint8Array, found: Set<string>): Promise<void> {
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      throwOnInvalidObject: true,
      updateMetadata: false,
      capNumbers: true
    })
  } catch (error) {
    throw new Refused(
      error instanceof EncryptedPDFError ? UNREADABLE.ENCRYPTED : UNREADABLE.NOT_READABLE
    )
  }
  // A file with no catalog is not a document anyone can say anything about
  const root = doc.context.trailerInfo.Root
  if (root === undefined || !(doc.context.lookup(root) instanceof PDFDict))
    throw new Refused(UNREADABLE.NOT_READABLE)
  const objects = doc.context.enumerateIndirectObjects()
  if (objects.length > PdfInspection.MAX_OBJECTS) throw new Refused(UNREADABLE.TOO_MANY_OBJECTS)
  // The references of the objects are looked at as well: a PDF reads the ones the trailer reaches, and so does
  // every object here; the trailer itself carries the root and the encryption
  const trailer = Object.values(doc.context.trailerInfo).filter(
    (value): value is PDFObject => value !== undefined
  )
  walk(doc.context, [...objects.map(([, object]) => object), ...trailer], found)
}

// What a PDF that stays as the evidence of a transaction carries that runs when it is opened (TAX-436), read by a
// PDF parser (the library of the worker): every name of every object, object streams included, and nothing of
// the data of the streams. Fail closed: anything not proven inert or not read whole comes back `unreadable`.
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspectionResult> {
  const found = new Set<string>()
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      scan(bytes, found),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Refused(UNREADABLE.TIME_BUDGET_EXCEEDED)),
          PdfInspection.TIME_BUDGET_MS
        )
      })
    ])
    return { names: [...found], unreadable: null }
  } catch (error) {
    return {
      names: [...found],
      unreadable: error instanceof Refused ? error.reason : UNREADABLE.INSPECTION_FAILED
    }
  } finally {
    clearTimeout(timer)
  }
}
