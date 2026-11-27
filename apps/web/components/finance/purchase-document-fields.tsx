'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { PURCHASE_ORIGINS, PurchaseLimits } from '@platform/core/domain'

import {
  type DocumentDraft,
  type DocumentField,
  DocumentFields
} from '../../lib/finance/purchase-form'

import { SelectField, TextField } from './fields'

// The data of the supplier's document that the annex of purchases of the return needs (D4b): the class and the type, the code of an
// electronic one, where the goods come from and how the cost counts for the income tax. The codes are the provider's and the api says which
// combinations are valid, so the form only carries them; all of it may be left blank and completed later.
export function PurchaseDocumentFields({
  draft,
  problem,
  disabled,
  onChange
}: {
  draft: DocumentDraft
  problem: DocumentField | null
  disabled: boolean
  onChange: (patch: Partial<DocumentDraft>) => void
}): ReactElement {
  const t = useTranslations('finance.purchases.document')
  const text = (field: DocumentField): string | null =>
    problem === field ? t(`problems.${field}`) : null
  return (
    <fieldset className="grid gap-3 rounded-md border p-3" data-testid="purchase-document-fields">
      <legend className="px-1 text-sm font-medium">{t('legend')}</legend>
      <p className="text-muted-foreground text-xs">{t('intro')}</p>
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label={t('fields.documentClass')}
          value={draft.documentClass}
          maxLength={PurchaseLimits.DOCUMENT_CODE_MAX_LENGTH}
          inputMode="numeric"
          disabled={disabled}
          problem={text(DocumentFields.CLASS)}
          onChange={documentClass => onChange({ documentClass })}
        />
        <TextField
          label={t('fields.documentType')}
          value={draft.documentType}
          maxLength={PurchaseLimits.DOCUMENT_CODE_MAX_LENGTH}
          inputMode="numeric"
          disabled={disabled}
          problem={text(DocumentFields.TYPE)}
          onChange={documentType => onChange({ documentType })}
        />
      </div>
      <TextField
        label={t('fields.generationCode')}
        value={draft.generationCode}
        maxLength={PurchaseLimits.GENERATION_CODE_MAX_LENGTH}
        autoCapitalize="characters"
        disabled={disabled}
        hint={t('fields.generationCodeHint')}
        problem={text(DocumentFields.GENERATION_CODE)}
        onChange={generationCode => onChange({ generationCode })}
      />
      <SelectField
        label={t('fields.origin')}
        value={draft.origin}
        disabled={disabled}
        onChange={value => {
          const origin = PURCHASE_ORIGINS.find(known => known === value)
          if (origin !== undefined) onChange({ origin })
        }}
      >
        {PURCHASE_ORIGINS.map(origin => (
          <option key={origin} value={origin}>
            {t(`origins.${origin}`)}
          </option>
        ))}
      </SelectField>
      <div className="grid grid-cols-3 gap-3">
        <TextField
          label={t('fields.expenseClass')}
          value={draft.expenseClass}
          maxLength={PurchaseLimits.DOCUMENT_CODE_MAX_LENGTH}
          inputMode="numeric"
          disabled={disabled}
          problem={text(DocumentFields.EXPENSE_CLASS)}
          onChange={expenseClass => onChange({ expenseClass })}
        />
        <TextField
          label={t('fields.sector')}
          value={draft.sector}
          maxLength={PurchaseLimits.DOCUMENT_CODE_MAX_LENGTH}
          inputMode="numeric"
          disabled={disabled}
          problem={text(DocumentFields.SECTOR)}
          onChange={sector => onChange({ sector })}
        />
        <TextField
          label={t('fields.costType')}
          value={draft.costType}
          maxLength={PurchaseLimits.DOCUMENT_CODE_MAX_LENGTH}
          inputMode="numeric"
          disabled={disabled}
          problem={text(DocumentFields.COST_TYPE)}
          onChange={costType => onChange({ costType })}
        />
      </div>
    </fieldset>
  )
}
