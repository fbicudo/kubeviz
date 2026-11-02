import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import ptBR from './locales/pt-BR.json'

export const languages = [
  { code: 'pt-BR', label: 'Português' },
  { code: 'en', label: 'English' },
] as const

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { 'pt-BR': { translation: ptBR }, en: { translation: en } },
    fallbackLng: 'en',
    supportedLngs: languages.map((l) => l.code),
    load: 'currentOnly',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'kubeviz.lang',
      caches: ['localStorage'],
      // "pt", "pt-PT" etc. caem em pt-BR; qualquer outro idioma, em inglês.
      convertDetectedLanguage: (lng) => (lng.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en'),
    },
  })

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng
})

export default i18n
