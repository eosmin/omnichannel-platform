const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] // "%PDF-"

// A file that begins like a PDF: what a carrier's label must be to be kept (TDD_17 §4.12). The scan and the content type
// are the other checks; this one stops a page of HTML or a picture that is declared a PDF.
export function hasPdfSignature(data: Uint8Array): boolean {
  return PDF_SIGNATURE.every((byte, index) => data[index] === byte)
}
