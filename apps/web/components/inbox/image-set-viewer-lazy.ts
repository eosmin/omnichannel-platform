import dynamic from 'next/dynamic'

// The viewer that walks the pictures of a message with the arrows, downloaded the first time a picture is opened:
// the inbox has a script budget. One declaration for the album and the block of pictures.
export const LazyImageSetViewer = dynamic(() => import('./image-set-viewer'), { ssr: false })
