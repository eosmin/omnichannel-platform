'use client'

import { ImagePlus, Star } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ChangeEvent, type ReactElement, useRef } from 'react'
import { useState } from 'react'

import type { ProductDetailView, ProductImageView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { MediaPurpose, ProductImageUpload } from '@platform/core/storage'

import { refuseAttachment, refusalCode } from '../../lib/media/attachment-rules'
import { useMediaUrls } from '../../lib/media/use-media-urls'
import {
  useProductImages,
  useProductImageUpload,
  useProductWrites
} from '../../lib/products/use-products'
import { useCodeText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { ProductError } from './product-error'

const BYTES_PER_MB = 1024 * 1024

// The "Pictures" tab: the live pictures of the product, the cover marked, and an upload. The upload goes
// through the one flow of every file (signed url, bucket, confirmation) with the purpose `product`; the
// picture shows once the scan says it is clean, and the cover can only be one of these pictures.
export function ImagesTab({ product }: { product: ProductDetailView }): ReactElement {
  const t = useTranslations('products.images')
  const tAll = useTranslations()
  const codeText = useCodeText()
  const { storeId, can } = useStore()
  const images = useProductImages(storeId, product.id)
  const upload = useProductImageUpload(storeId, product.id)
  const writes = useProductWrites(storeId, product.id)
  const input = useRef<HTMLInputElement>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const mayUpload = can(ClientPermissions.PRODUCTS_EDIT) && can(ClientPermissions.MEDIA_UPLOAD)
  const mayEdit = can(ClientPermissions.PRODUCTS_EDIT)
  const mayPreview = can(ClientPermissions.MEDIA_VIEW)

  const pick = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    // The api checks again; here the person hears it before any byte leaves the browser
    const refusal = refuseAttachment(file, MediaPurpose.PRODUCT)
    if (refusal !== null) {
      upload.reset()
      setRefused(codeText(refusalCode(refusal)))
      return
    }
    setRefused(null)
    upload.reset()
    upload.mutate(file)
  }

  return (
    <section aria-labelledby="product-images-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h3 id="product-images-heading" className="font-medium">
            {t('heading')}
          </h3>
          <p className="text-muted-foreground text-sm">
            {t('description', { size: ProductImageUpload.MAX_SIZE_BYTES / BYTES_PER_MB })}
          </p>
        </div>
        {mayUpload ? (
          <>
            <input
              ref={input}
              type="file"
              className="sr-only"
              tabIndex={-1}
              aria-label={t('upload')}
              accept={ProductImageUpload.CONTENT_TYPES.join(',')}
              onChange={pick}
            />
            <Button
              type="button"
              variant="outline"
              disabled={upload.isPending}
              busy={upload.isPending}
              onClick={() => input.current?.click()}
            >
              <ImagePlus aria-hidden />
              {upload.isPending ? t('uploading') : t('upload')}
            </Button>
          </>
        ) : null}
      </div>
      {refused !== null ? (
        <p role="alert" className="text-destructive text-sm">
          {refused}
        </p>
      ) : null}
      <ProductError error={upload.error ?? writes.update.error} />
      {!mayPreview ? <p className="text-muted-foreground text-sm">{t('noMediaAccess')}</p> : null}
      {images.isError && images.data === undefined ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>{t('failed')}</p>
          <Button variant="outline" size="sm" onClick={() => void images.refetch()}>
            {tAll('common.tryAgain')}
          </Button>
        </div>
      ) : null}
      {images.data?.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : null}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {images.data?.map(image => (
          <Tile
            key={image.id}
            image={image}
            isCover={product.imageMediaId === image.id}
            mayPreview={mayPreview}
            mayEdit={mayEdit}
            isPending={writes.update.isPending}
            onCover={cover => writes.update.mutate({ imageMediaId: cover ? image.id : null })}
          />
        ))}
      </ul>
    </section>
  )
}

function Tile({
  image,
  isCover,
  mayPreview,
  mayEdit,
  isPending,
  onCover
}: {
  image: ProductImageView
  isCover: boolean
  mayPreview: boolean
  mayEdit: boolean
  isPending: boolean
  onCover: (cover: boolean) => void
}): ReactElement {
  const t = useTranslations('products.images')
  const { storeId } = useStore()
  const isClean = image.status === 'clean'
  const urls = useMediaUrls(storeId, image.id, isClean && mayPreview)
  const thumb = urls.data?.variants.thumb ?? urls.data?.variants.medium ?? null
  return (
    <li className="flex flex-col gap-2 rounded-md border p-2">
      <div className="bg-muted flex aspect-square items-center justify-center overflow-hidden rounded-sm">
        {thumb !== null ? (
          // eslint-disable-next-line @next/next/no-img-element -- a signed link on the bucket host: next/image would need it configured
          <img
            src={thumb}
            alt={t('tileLabel', { name: image.filename })}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="size-full object-cover"
          />
        ) : (
          <span className="text-muted-foreground px-2 text-center text-xs">
            {isClean ? t('noPreview') : t('checking')}
          </span>
        )}
      </div>
      <p className="truncate text-xs" title={image.filename}>
        {image.filename}
      </p>
      {isCover ? (
        <span className="flex items-center gap-1 text-xs font-medium">
          <Star aria-hidden className="size-3" />
          {t('cover')}
        </span>
      ) : null}
      {mayEdit && isClean ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() => onCover(!isCover)}
        >
          {isCover ? t('clearCover') : t('setCover')}
        </Button>
      ) : null}
    </li>
  )
}
