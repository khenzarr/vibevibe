import { formatEther, isAddress, maxUint256, zeroAddress, type Address, type Hex } from 'viem'
import { rpcClient } from './protocol'
import { buyReceipt, executionZap, readBuy, restoreBuy, reviewBuy, tradePendingKey, transactionHashPattern, type BuyReview, type PendingBuy } from './testnet-buy'
import { readSell, restoreSell, reviewSell, sellReceipt, type PendingSell } from './testnet-sell'
import { onTestnet, walletAccount, walletActionLock, walletErrorCode, type WalletProvider } from './wallet'

type Connected = { provider: WalletProvider; account: Address }
type Review = (BuyReview & { kind: 'buy'; token: Address })
  | (Awaited<ReturnType<typeof reviewSell>> & { token: Address; size: bigint })
type Pending = PendingBuy | PendingSell
const message = (error: unknown) => error instanceof Error ? error.message.split('\n')[0] : 'The testnet trade could not be prepared.'
const restore = (raw: string | null): Pending | undefined => {
  if (raw === null) return
  const saved = JSON.parse(raw)
  return saved?.kind === undefined ? restoreBuy(raw) : restoreSell(saved)
}
const receiptFor = (entry: Pending, hash: Hex) => 'kind' in entry ? sellReceipt(entry, hash, rpcClient()) : buyReceipt(entry, hash, rpcClient())
const buyLimitFields = ['size', 'cap', 'age', 'tax', 'impact', 'slippage'] as const
type CandidateLimits = Record<typeof buyLimitFields[number], string>
type WatchBuy = { token: string; limits?: CandidateLimits }
const watchBuyEvent = 'launchpilot:watch-buy'

export function reviewWatchedBuy(token: string, limits?: CandidateLimits) {
  window.dispatchEvent(new CustomEvent<WatchBuy>(watchBuyEvent, { detail: { token, limits } }))
}

export function setupBuyPanel(connected: () => Connected | undefined, launchPending: () => boolean) {
  const get = <T extends HTMLElement>(name: string) => document.getElementById(`test-buy-${name}`) as T
  const form = get<HTMLFormElement>('form')
  const reviewButton = get<HTMLButtonElement>('review')
  const send = get<HTMLButtonElement>('send')
  const check = get<HTMLButtonElement>('check')
  const recovery = get<HTMLDetailsElement>('recovery')
  const hashField = get<HTMLInputElement>('hash')
  const status = get('status')
  const payload = get('payload')
  const explorer = get<HTMLAnchorElement>('explorer')
  const side = get<HTMLSelectElement>('side')
  const tokenField = form.elements.namedItem('token') as HTMLInputElement
  const source = get('source')
  let review: Review | undefined
  let revision = 0
  let pending = false
  let busy = false
  let checking = false
  let receiptTimer: number | undefined
  let receiptChecks = 0

  const show = (text: string) => { status.textContent = text }
  const buttons = () => {
    send.disabled = !review || pending || busy
    reviewButton.disabled = pending || busy
  }
  function invalidate() {
    revision++
    review = undefined
    payload.hidden = true
    buttons()
  }
  function showSide() {
    reviewButton.textContent = side.value === 'sell' ? 'Review testnet sell' : 'Review testnet buy'
    for (const label of form.querySelectorAll<HTMLElement>('[data-trade-side]')) {
      label.hidden = label.dataset.tradeSide !== side.value
      label.querySelector('input')!.disabled = label.hidden
    }
  }
  async function prepare(account: Address, previous?: Review): Promise<Review> {
    const values = new FormData(form)
    if (side.value === 'sell') {
      const draft = readSell(values)
      return { ...await reviewSell(draft, account, rpcClient(), previous?.kind === 'buy' ? undefined : previous), token: draft.token, size: draft.size }
    }
    const draft = readBuy(values)
    return { ...await reviewBuy(draft, account, rpcClient(), previous?.kind === 'buy' ? previous : undefined), kind: 'buy', token: draft.token }
  }
  function link(hash?: Hex) {
    explorer.hidden = !hash
    if (hash) explorer.href = `https://explorer.testnet.chain.robinhood.com/tx/${hash}`
  }
  function display(entry?: Pending) {
    pending = Boolean(entry)
    check.hidden = !entry?.hash
    recovery.hidden = !entry || Boolean(entry.hash)
    link(entry?.hash)
    buttons()
  }
  function save(entry?: Pending) {
    if (entry) localStorage.setItem(tradePendingKey, JSON.stringify(entry))
    else localStorage.removeItem(tradePendingKey)
    display(entry)
  }

  async function locked(action: () => Promise<void> | void) {
    if (!navigator.locks) return show('This browser does not support safe wallet request locking.')
    try {
      await navigator.locks.request(walletActionLock, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('A wallet request is already active in another panel or tab.')
        await action()
      })
    } catch (error) {
      show(message(error))
    }
  }

  async function checkReceipt() {
    if (checking) return
    checking = true
    window.clearTimeout(receiptTimer)
    try {
      const raw = localStorage.getItem(tradePendingKey)
      const entry = restore(raw)
      if (!entry?.hash) return
      const result = await receiptFor(entry, entry.hash)
      if (localStorage.getItem(tradePendingKey) !== raw) return
      if (result.state === 'pending') {
        show('Transaction submitted. Waiting for the testnet receipt.')
        if (++receiptChecks < 10) receiptTimer = window.setTimeout(() => { void checkReceipt() }, 5000)
      } else if (result.state === 'unverified') {
        show('Receipt does not match the trade. Check the explorer before submitting again.')
      } else {
        save()
        link(entry.hash)
        if (result.state === 'confirmed') show(`Buy confirmed · ${formatEther(result.tokens)} tokens received · ${formatEther(result.gasCost)} test ETH network fee.`)
        else if (result.state === 'approved') show(`Exact token allowance confirmed · ${formatEther(result.gasCost)} test ETH network fee. Review the sale now.`)
        else if (result.state === 'sold') show(`Sale confirmed · ${formatEther(result.size)} tokens sold · ${formatEther(result.amountOut)} test ETH received · ${formatEther(result.gasCost)} test ETH fee · ${formatEther(result.balance)} tokens remaining at the receipt block.`)
        else show('The testnet reverted this transaction. Review a new quote before trying again.')
      }
    } catch (error) {
      show(message(error))
    } finally {
      checking = false
    }
  }

  function syncPending() {
    window.clearTimeout(receiptTimer)
    receiptChecks = 0
    try {
      const entry = restore(localStorage.getItem(tradePendingKey))
      display(entry)
      if (entry?.hash) void checkReceipt()
      else if (entry) show('Submission is unknown. Recover the hash from your wallet history.')
    } catch {
      pending = true
      recovery.hidden = false
      buttons()
      show('Saved trade could not be read. Check your wallet history before clearing it.')
    }
  }

  form.addEventListener('input', () => {
    invalidate()
    if (!pending && !busy) show('Settings changed. Review a fresh testnet quote.')
  })
  side.addEventListener('change', showSide)
  tokenField.addEventListener('input', () => { source.hidden = true })

  function loadCandidate({ token, limits }: WatchBuy, fromWorker = false) {
    if (!isAddress(token, { strict: false }) || token.toLowerCase() === zeroAddress) return
    if (!fromWorker) get('heading').focus()
    source.hidden = false
    if (pending || busy) {
      source.textContent = 'Finish the current wallet request or review before choosing another candidate.'
      return
    }
    invalidate()
    side.value = 'buy'
    showSide()
    tokenField.value = token
    if (limits) {
      for (const key of buyLimitFields) (form.elements.namedItem(key) as HTMLInputElement).value = limits[key]
    }
    source.textContent = limits
      ? 'Started from a paper candidate. Buy size and per-trade limits copied. The paper budget and positions stay separate.'
      : fromWorker ? 'Token copied from the local launch worker. Review the current buy limits.'
        : 'Token copied from Launch watch. Using the current buy limits.'
    if (!fromWorker && connected()) form.requestSubmit(reviewButton)
    else show('Connect your browser wallet on Robinhood Chain Testnet, then review the buy.')
  }

  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (pending || busy) return
    invalidate()
    const wallet = connected()
    if (!wallet) return show('Connect the browser wallet and switch to Robinhood Chain Testnet above.')
    const expectedRevision = revision
    busy = true
    buttons()
    link()
    show('Reading the V6 curve and simulating the transaction…')
    try {
      const next = await prepare(wallet.account)
      if (revision !== expectedRevision) throw new Error('Wallet or settings changed. Review again.')
      review = next
      payload.hidden = false
      get('data').textContent = JSON.stringify({
        chainId: 46630, action: next.kind, token: next.token,
        ...(next.kind === 'approval' ? { spender: executionZap, amount: next.size.toString() }
          : { deadline: next.deadline.toString(), minimumOutput: next.minOut.toString() }),
        ...next.transaction,
      }, null, 2)
      if (next.kind === 'buy') show(`Block ${next.block} · Minimum ${formatEther(next.minOut)} tokens · Tax ${Number(next.tax) / 100}% · Price impact ${Number(next.impact) / 100}% · Total up to ${formatEther(next.total)} test ETH including ${formatEther(next.gasCost)} gas reserve. Review the wallet fee before confirming.`)
      else if (next.kind === 'approval') show(`Allowance needed · ${formatEther(next.held)} tokens held · Authorize only ${formatEther(next.size)} tokens for the V6 zap · ${formatEther(next.gasCost)} test ETH gas reserve for approval. Review the sale separately after confirmation.`)
      else {
        const allowance = next.allowance === maxUint256 ? 'unlimited' : `${formatEther(next.allowance)} tokens`
        show(`Block ${next.block} · ${formatEther(next.held)} tokens held · Sell ${formatEther(next.size)} tokens · Minimum ${formatEther(next.minOut)} test ETH before gas · ${formatEther(next.gasCost)} test ETH gas reserve · On-chain allowance for the V6 zap: ${allowance}. Review the wallet fee before confirming.`)
      }
    } catch (error) {
      show(message(error))
    } finally {
      busy = false
      buttons()
    }
  })

  send.addEventListener('click', () => { void locked(async () => {
    const wallet = connected()
    const previous = review
    if (!previous || !wallet || busy) return
    if (launchPending() || localStorage.getItem(tradePendingKey) !== null) throw new Error('Resolve the pending wallet transaction first.')
    busy = true
    buttons()
    let requested = false
    try {
      show('Refreshing the reviewed transaction before opening your wallet…')
      const fresh = await prepare(wallet.account, previous)
      const [account, correctNetwork] = await Promise.all([walletAccount(wallet.provider), onTestnet(wallet.provider)])
      if (!correctNetwork || account.toLowerCase() !== previous.transaction.from.toLowerCase()
        || wallet.provider !== connected()?.provider || review !== previous) throw new Error('Wallet or settings changed. Review again.')
      const base = { transaction: fresh.transaction, curve: fresh.curve }
      const entry: Pending = fresh.kind === 'buy' ? base
        : { ...base, kind: fresh.kind, token: fresh.token, size: fresh.size.toString(), minimum: fresh.minOut.toString() }
      save(entry)
      recovery.hidden = true
      invalidate()
      show('Review and approve the testnet transaction in your wallet.')
      requested = true
      const hash = await wallet.provider.request({ method: 'eth_sendTransaction', params: [fresh.transaction] })
      if (typeof hash !== 'string' || !transactionHashPattern.test(hash)) throw new Error('Unknown wallet response.')
      save({ ...entry, hash: hash as Hex })
      receiptChecks = 0
      void checkReceipt()
    } catch (error) {
      invalidate()
      if (requested && walletErrorCode(error) === 4001) {
        save()
        show('Wallet approval cancelled. Review again when ready.')
      } else if (requested) {
        recovery.hidden = false
        show('Submission is unknown. Check wallet history before trying again.')
      } else show(message(error))
    } finally {
      busy = false
      buttons()
    }
  }) })

  check.addEventListener('click', () => { receiptChecks = 0; void checkReceipt() })
  get('recover').addEventListener('click', () => { void locked(async () => {
    const hash = hashField.value.trim()
    if (!transactionHashPattern.test(hash)) return show('Enter a valid transaction hash from wallet history.')
    const entry = restore(localStorage.getItem(tradePendingKey))
    if (!entry || entry.hash) return
    const result = await receiptFor(entry, hash as Hex)
    if (result.state === 'pending' || result.state === 'unverified') return show('This hash does not have a matching verified receipt yet.')
    save({ ...entry, hash: hash as Hex })
    await checkReceipt()
  }) })
  get('clear').addEventListener('click', () => { void locked(() => {
    if (!window.confirm('Clear the unknown trade only if you checked wallet history and no transaction was submitted.')) return
    save()
    invalidate()
    show('Saved trade cleared. Review a new quote when ready.')
  }) })
  window.addEventListener('storage', event => {
    if (event.key !== tradePendingKey) return
    invalidate()
    syncPending()
  })
  showSide()
  syncPending()
  window.addEventListener(watchBuyEvent, event => loadCandidate((event as CustomEvent<WatchBuy>).detail))
  const watched = new URLSearchParams(window.location.search).get('watchBuy')
  if (watched) loadCandidate({ token: watched }, true)
  return () => {
    invalidate()
    if (!pending && !busy) show('Wallet changed. Review a fresh quote on Robinhood Chain Testnet.')
  }
}
