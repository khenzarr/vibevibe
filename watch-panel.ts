import { restoreWatch, scanLaunches, watchKey, type WatchState } from './launch-watch'
import { rpcClient } from './protocol'
import { pickPaperToken } from './paper-panel'
import { reviewWatchedBuy } from './testnet-buy-panel'

const button = document.querySelector<HTMLButtonElement>('#watch-toggle')!
const status = document.querySelector<HTMLElement>('#watch-status')!
const results = document.querySelector<HTMLOListElement>('#watch-results')!
let controller: AbortController | undefined
let timer: number | undefined
let state: WatchState | undefined

function render(rows: WatchState['rows']) {
  results.replaceChildren(...rows.map(row => {
    const li = document.createElement('li')
    const token = document.createElement('a')
    token.href = `https://testnet.vibevibe.fun/token/${row.token}`
    token.target = '_blank'
    token.rel = 'noopener noreferrer'
    token.textContent = `${row.name} ($${row.symbol})`
    const detail = document.createElement('span')
    detail.textContent = `Block ${row.block} · ${row.taxBps / 100}% base tax · ${row.ethPair ? 'ETH pair' : 'Pair outside scope'}`
    li.append(token, detail)
    if (row.ethPair) {
      const paper = document.createElement('button')
      paper.className = 'ghost'
      paper.type = 'button'
      paper.textContent = 'Try paper trade'
      paper.addEventListener('click', () => pickPaperToken(row.token))
      const buy = document.createElement('button')
      buy.className = 'ghost'
      buy.type = 'button'
      buy.textContent = 'Review buy'
      buy.addEventListener('click', () => reviewWatchedBuy(row.token))
      li.append(paper, buy)
    }
    return li
  }))
}

async function tick(active: AbortController) {
  try {
    const next = await scanLaunches(state, rpcClient(active.signal))
    if (controller !== active) return
    state = next
    render(next.rows)
    try {
      localStorage.setItem(watchKey, JSON.stringify(next))
      status.textContent = `Tracking · scanned through block ${BigInt(next.nextBlock) - 1n} · ${next.rows.length} recent launches`
    } catch {
      status.textContent = 'Tracking · this browser could not save the scan position.'
    }
  } catch {
    if (controller !== active) return
    status.textContent = 'Testnet read failed. Retrying from the last successfully scanned block.'
  }
  if (controller === active) timer = window.setTimeout(() => { void tick(active) }, 12000)
}

try {
  state = restoreWatch(localStorage.getItem(watchKey))
  if (state) render(state.rows)
} catch {
  status.textContent = 'The saved scan could not be read. Start tracking to scan the latest blocks.'
}

button.addEventListener('click', () => {
  if (controller) {
    controller.abort()
    controller = undefined
    window.clearTimeout(timer)
    button.textContent = 'Resume tracking'
    status.textContent = 'Tracking paused.'
    return
  }
  controller = new AbortController()
  button.textContent = 'Pause tracking'
  status.textContent = 'Reading V6 launches from Robinhood Testnet…'
  void tick(controller)
})
