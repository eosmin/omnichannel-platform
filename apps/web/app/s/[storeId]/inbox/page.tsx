import { pageTitle } from '../page-title'

// The frame (app/s/inbox-frame.tsx) draws both sides from the address; the page is there so that the
// route exists. The thread of Step 3.2, PR B2, goes in the frame beside the header.
export const generateMetadata = pageTitle('inbox')

export default function InboxPage(): null {
  return null
}
