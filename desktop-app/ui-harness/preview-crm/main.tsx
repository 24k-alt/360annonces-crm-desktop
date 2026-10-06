import '@fontsource-variable/inter/wght.css'
import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'
import { createRoot } from 'react-dom/client'
import { useColorScheme } from 'twenty-sdk/front-component'
import { twentyTokens } from '../../../twenty-real-estate-crm/agency-crm/shared/front-components/twenty-tokens'
import { PilotageDashboard } from '../../../twenty-real-estate-crm/agency-crm/shared/front-components/pilotage-dashboard'
import { WhatsAppControl } from '../../../twenty-real-estate-crm/agency-crm/shared/front-components/whatsapp-control'
import { HelpCenter } from '../../../twenty-real-estate-crm/agency-crm/shared/front-components/help-center'

const q = new URLSearchParams(location.search)
const Page = { dash: PilotageDashboard, wa: WhatsAppControl, help: HelpCenter }[q.get('page') ?? 'dash'] ?? PilotageDashboard
function Host() {
  const t = twentyTokens[useColorScheme() === 'dark' ? 'dark' : 'light']
  document.body.style.background = t.backgroundPrimary
  return <Page />
}
createRoot(document.getElementById('root')!).render(<Host />)

const st = document.createElement('style')
st.textContent = `@font-face{font-family:Inter;src:url(${interUrl}) format('woff2');font-weight:100 900}`
document.head.appendChild(st)
