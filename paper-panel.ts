import { formatEther, formatUnits } from 'viem'
import { paperEntry, paperExit, paperMarket, paperSettings, requireFreshQuote, type PaperPosition, type PaperSettings } from './paper-trade'
import { rpcClient } from './protocol'

const form = document.querySelector<HTMLFormElement>('#paper-form')!
const fields = document.querySelector<HTMLFieldSetElement>('#paper-fields')!
const token = document.querySelector<HTMLInputElement>('#paper-token')!
const quoteButton = document.querySelector<HTMLButtonElement>('#paper-quote')!
const openButton = document.querySelector<HTMLButtonElement>('#paper-open')!
const reset = document.querySelector<HTMLButtonElement>('#paper-reset')!
const status = document.querySelector<HTMLElement>('#paper-status')!
let active: AbortController | undefined
let timer: number | undefined

const showEntry = (entry: PaperPosition) => `Block ${entry.block} · Quote ${formatEther(entry.out)} tokens · Minimum ${formatEther(entry.tokens)} tokens · ${formatEther(entry.cost)} test ETH with gas reserve · Tax ${formatUnits(entry.tax, 2)}% · Price impact ${formatUnits(entry.impact, 2)}%`

export function pickPaperToken(address: string) {
  if (!fields.disabled) {
    token.value = address
    status.textContent = 'Token selected. Review your limits and check a fresh buy quote.'
  }
  status.scrollIntoView({ block: 'nearest' })
  if (!fields.disabled) token.focus({ preventScroll: true })
}

async function monitor(settings: PaperSettings, entry: PaperPosition, session: AbortController) {
  try {
    const market = await paperMarket(settings.token, 'sell', rpcClient(session.signal))
    if (market.number < entry.block) throw new Error('Waiting for a block at or after the paper entry.')
    const [, , , out] = await market.sell(entry.tokens)
    requireFreshQuote(market.timestamp)
    const exit = paperExit(entry, out, market.fee, settings)
    if (active !== session) return
    const net = `${formatEther(exit.proceeds)} test ETH after slippage and gas reserve`
    const profit = `${formatEther(exit.profit)} test ETH P/L`
    if (exit.trigger) {
      status.textContent = `Paper position closed · ${exit.trigger} · Block ${market.number} · ${net} · ${profit}.`
      reset.textContent = 'Start a new paper session'
      return
    }
    status.textContent = `Paper position open · Block ${market.number} · Exit estimate ${net} · ${profit}.`
  } catch (error) {
    if (active !== session) return
    status.textContent = `Paper position open · Exit paused. ${error instanceof Error ? error.message : 'Live quote unavailable.'}`
  }
  if (active === session) timer = window.setTimeout(() => { void monitor(settings, entry, session) }, 12000)
}

form.addEventListener('submit', async event => {
  event.preventDefault()
  if (active) return
  let settings: PaperSettings
  try {
    settings = paperSettings(new FormData(form))
  } catch (error) {
    status.textContent = (error as Error).message
    return
  }
  const session = new AbortController()
  active = session
  fields.disabled = quoteButton.disabled = openButton.disabled = true
  status.textContent = 'Checking a live testnet quote…'
  let opened = false
  try {
    const market = await paperMarket(settings.token, 'buy', rpcClient(session.signal))
    const entry = await paperEntry(settings, market)
    requireFreshQuote(market.timestamp)
    if (event.submitter !== openButton) {
      status.textContent = showEntry(entry)
      return
    }
    opened = true
    reset.hidden = false
    reset.textContent = 'End paper session'
    status.textContent = `Paper position open · ${showEntry(entry)}`
    void monitor(settings, entry, session)
  } catch (error) {
    status.textContent = (error as Error).message
  } finally {
    if (!opened) {
      active = undefined
      fields.disabled = quoteButton.disabled = openButton.disabled = false
    }
  }
})

form.addEventListener('input', () => {
  if (!active) status.textContent = 'Settings changed. Check a fresh quote.'
})

reset.addEventListener('click', () => {
  active?.abort()
  active = undefined
  window.clearTimeout(timer)
  fields.disabled = quoteButton.disabled = openButton.disabled = false
  reset.hidden = true
  status.textContent = 'Paper session ended. Ready for a fresh quote.'
})
