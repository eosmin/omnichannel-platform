import { useState } from 'react'

// True from the render in which `wanted` was true, and then for good. A dialog loaded with
// next/dynamic is rendered only from then on, so its code is downloaded when it is first needed, and
// it stays mounted afterwards so that it can play its closing animation. The state is set while
// rendering (React's way to derive state from a prop), never a ref, so a discarded render leaves no trace.
export function useMountedOnce(wanted: boolean): boolean {
  const [mounted, setMounted] = useState(wanted)
  if (wanted && !mounted) setMounted(true)
  return mounted || wanted
}
