// What a click on a quote shows at the original: a ring and a tint that stay a moment and fade. The transition is
// put on the element only for that time (a message has the focus ring of the keyboard as a shadow too, which must
// appear at once the rest of the time), and none for a reader who asked for less motion: the mark is then shown
// and removed, never animated. One mark at a time: a new jump takes the old one off.
export const HIGHLIGHT_MS = 2200
export const FADE_MS = 800
export const HIGHLIGHT_CLASSES = ['ring-2', 'ring-primary', 'bg-primary/15'] as const
export const TRANSITION_CLASSES = [
  'transition-[background-color,box-shadow]',
  'duration-700',
  'motion-reduce:transition-none'
] as const

interface Markable {
  classList: { add: (...names: string[]) => void; remove: (...names: string[]) => void }
}

interface Mark {
  element: Markable
  timers: ReturnType<typeof setTimeout>[]
}
let current: Mark | null = null

function clear(mark: Mark): void {
  for (const timer of mark.timers) clearTimeout(timer)
  mark.element.classList.remove(...HIGHLIGHT_CLASSES, ...TRANSITION_CLASSES)
}

export function highlightFor(element: Markable): void {
  if (current !== null) clear(current)
  // The transition first, then the mark, so that the mark itself fades in
  element.classList.add(...TRANSITION_CLASSES)
  element.classList.add(...HIGHLIGHT_CLASSES)
  const mark: Mark = { element, timers: [] }
  mark.timers.push(
    setTimeout(() => {
      element.classList.remove(...HIGHLIGHT_CLASSES)
      mark.timers.push(
        setTimeout(() => {
          element.classList.remove(...TRANSITION_CLASSES)
          if (current === mark) current = null
        }, FADE_MS)
      )
    }, HIGHLIGHT_MS)
  )
  current = mark
}

// Said to a screen reader through a live region, written by hand and not through state: the thread does not draw
// again for it, and the same words said twice are announced twice (the region is emptied first, and cleared after)
export function announce(region: { textContent: string | null } | null, text: string): void {
  if (region === null) return
  region.textContent = ''
  setTimeout(() => {
    region.textContent = text
    setTimeout(() => {
      region.textContent = ''
    }, HIGHLIGHT_MS)
  }, 50)
}
