import { formatEther } from 'viem'
import { launchHead, scanLaunchBatch } from './launch-watch'
import { addLaunches, evaluateSession, newPaperSession, paperTotals, restoreSession, sessionKey, type PaperSession } from './paper-session'
import { rpcClient } from './protocol'
import { reviewWatchedBuy } from './testnet-buy-panel'

const form = document.querySelector<HTMLFormElement>('#auto-paper-form')!
const fields = document.querySelector<HTMLFieldSetElement>('#auto-paper-fields')!
const start = document.querySelector<HTMLButtonElement>('#auto-paper-start')!
const pause = document.querySelector<HTMLButtonElement>('#auto-paper-pause')!
const clear = document.querySelector<HTMLButtonElement>('#auto-paper-clear')!
const status = document.querySelector<HTMLElement>('#auto-paper-status')!
const totals = document.querySelector<HTMLElement>('#auto-paper-totals')!
const ledger = document.querySelector<HTMLOListElement>('#auto-paper-ledger')!
let controller: AbortController | undefined
let hasSaved = false

function render(session?: PaperSession) {
  fields.disabled = hasSaved || Boolean(controller)
  start.textContent = hasSaved ? 'Resume paper session' : 'Start paper session'
  clear.hidden = !hasSaved || Boolean(controller)
  totals.hidden = !session
  if (!session) {
    ledger.replaceChildren()
    return
  }
  for (const [key, value] of Object.entries(session.config)) {
    const input = form.elements.namedItem(key)
    if (input instanceof HTMLInputElement) input.value = value
  }
  const { spent, pnl, open } = paperTotals(session)
  const { budget, maxOpen } = session.config
  totals.textContent = `Buy budget used ${formatEther(spent)} / ${budget} test ETH · Open ${open} / ${maxOpen} · Realized virtual P/L ${formatEther(pnl)} test ETH`
  const rows = [...session.rows].sort((a, b) => Number(BigInt(b.block) - BigInt(a.block)))
  ledger.replaceChildren(...rows.map(row => {
    const item = document.createElement('li')
    const link = document.createElement('a')
    link.textContent = `$${row.symbol}`
    link.href = `https://testnet.vibevibe.fun/token/${row.token}`
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    const detail = document.createElement('span')
    detail.textContent = `${row.state.toUpperCase()} · Launch block ${row.block} · ${row.reason}`
    item.append(link, detail)
    if (row.fill) {
      const fill = document.createElement('span')
      const held = BigInt(row.fill.tokens) - BigInt(row.fill.exit?.tokens ?? 0)
      const exit = row.fill.exit
      const closed = exit ? ` · Sold ${formatEther(BigInt(exit.tokens))} · P/L ${formatEther(BigInt(exit.profit))} test ETH · Exit block ${exit.block}` : ''
      fill.textContent = `Held ${formatEther(held)} · Buy cost ${formatEther(BigInt(row.fill.cost))} test ETH · Entry block ${row.fill.block}${closed}`
      item.append(fill)
      const buy = document.createElement('button')
      buy.className = 'ghost'
      buy.type = 'button'
      buy.textContent = 'Review buy with these limits'
      buy.addEventListener('click', () => reviewWatchedBuy(row.token, session.config))
      item.append(buy)
    }
    return item
  }))
}

function readSaved() {
  const raw = localStorage.getItem(sessionKey)
  hasSaved = raw !== null
  return restoreSession(raw)
}

function save(session: PaperSession) {
  const snapshot = JSON.stringify(session)
  if (localStorage.getItem(sessionKey) === snapshot) return
  localStorage.setItem(sessionKey, snapshot)
  hasSaved = true
  render(session)
}

function showSaved(message?: string) {
  try {
    const session = readSaved()
    render(session)
    status.textContent = message ?? (session ? 'Saved session paused. Resume to continue from the recorded block.' : 'Ready to start.')
  } catch {
    render()
    status.textContent = 'Saved session could not be read. Clear it to start a new one.'
  }
}

function waitForTick(signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) return resolve()
    const finish = () => {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = window.setTimeout(finish, 12000)
    signal.addEventListener('abort', finish, { once: true })
  })
}

async function runSession(draft: PaperSession | undefined, signal: AbortSignal) {
  const rpc = rpcClient(signal)
  let session = readSaved()
  if (!session) {
    if (!draft) throw new Error('The saved session was cleared. Check the settings and start again.')
    const head = await launchHead(rpc)
    signal.throwIfAborted()
    session = { ...draft, nextBlock: (head + 1n).toString() }
    save(session)
  }
  while (!signal.aborted) {
    let scanFailed = false
    if (!session.full) {
      let batch
      try {
        batch = await scanLaunchBatch(session.nextBlock, rpc)
      } catch {
        scanFailed = true
      }
      signal.throwIfAborted()
      if (batch) {
        session = addLaunches(session, batch)
        save(session)
      }
    }
    if (session.rows.length) {
      session = await evaluateSession(session, signal, undefined, !scanFailed)
      save(session)
    }
    status.textContent = scanFailed ? 'Testnet scan unavailable. Retrying from the saved block.'
      : session.full ? 'Ledger limit reached. Watching saved candidates and positions.'
        : `Paper session running · Next scan block ${session.nextBlock} · ${session.rows.length} tracked candidates.`
    await waitForTick(signal)
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault()
  if (controller) return
  if (!navigator.locks) {
    status.textContent = 'This browser does not support the paper session lock.'
    return
  }
  let draft: PaperSession | undefined
  try {
    if (!hasSaved) draft = newPaperSession(new FormData(form), 0n)
  } catch (error) {
    status.textContent = (error as Error).message
    return
  }
  const current = new AbortController()
  controller = current
  fields.disabled = start.disabled = true
  clear.hidden = true
  pause.hidden = false
  pause.disabled = false
  status.textContent = 'Connecting to the Robinhood testnet…'
  let message
  try {
    await navigator.locks.request(sessionKey, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('A paper session is already running in another tab.')
      if (!current.signal.aborted) await runSession(draft, current.signal)
    })
  } catch (error) {
    if (!current.signal.aborted) message = (error as Error).message
  } finally {
    controller = undefined
    pause.hidden = true
    start.disabled = false
    showSaved(message)
  }
})

pause.addEventListener('click', () => {
  controller?.abort()
  pause.disabled = true
  status.textContent = 'Pausing paper session…'
})

clear.addEventListener('click', async () => {
  if (controller || !navigator.locks || !window.confirm('Clear this saved virtual session, including its ledger?')) return
  try {
    await navigator.locks.request(sessionKey, { ifAvailable: true }, lock => {
      if (!lock) throw new Error('Pause the paper session in the other tab before clearing it.')
      localStorage.removeItem(sessionKey)
    })
    showSaved()
  } catch (error) {
    status.textContent = (error as Error).message
  }
})

window.addEventListener('storage', event => {
  if (!controller && (event.key === sessionKey || event.key === null)) showSaved()
})
showSaved()
