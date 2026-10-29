const SVG_NS = 'http://www.w3.org/2000/svg'

type Child = Node | string

// Elements are built with the DOM and given text as text, never as markup: what a visitor or the team
// writes cannot become HTML, and no inline script or style is ever needed
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  children: Child[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  node.append(...children)
  return node
}

// Paths of the Lucide icons the widget draws
export const Icons = {
  chat: ['M7.9 20A9 9 0 1 0 4 16.1L2 22Z'],
  close: ['M18 6 6 18', 'm6 6 12 12'],
  send: [
    'M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z',
    'M6 12h16'
  ]
} as const

export function icon(paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}
