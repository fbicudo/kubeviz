import { Construction } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function Placeholder({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">{t(titleKey)}</h1>
      <div className="flex max-w-lg items-start gap-3 rounded-lg border border-dashed bg-surface p-4">
        <Construction className="mt-0.5 size-5 text-warn" aria-hidden />
        <div>
          <div className="font-medium">{t('placeholder.title')}</div>
          <p className="text-muted">{t('placeholder.body')}</p>
        </div>
      </div>
    </div>
  )
}
