import './style.css'
import { isAddress, type Address, type Hex } from 'viem'
import { eth, quantity, readDraft, readLaunchReceipt, refusalMessage, rehearse, reviewForWallet, rpcClient, RpcError, type ExpectedLaunch, type Fields, type Review } from './protocol'
import { discoverWallets, onTestnet, switchToTestnet, walletAccount, walletActionLock, walletErrorCode, type WalletOption } from './wallet'
import { checkPublicMetadata, ipfsHttp, ipfsUri } from './metadata'
import { setupBuyPanel } from './testnet-buy-panel'
import { tradePendingKey } from './testnet-buy'
import { checkExecutionSupport } from './wallet-automation'

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const text = (id: string, value: string) => { byId(id).textContent = value }
const form = byId<HTMLFormElement>('draft')
const run = byId<HTMLButtonElement>('run')
const pin = byId<HTMLButtonElement>('pin')
const badge = byId('badge')
const senderField = form.elements.namedItem('sender') as HTMLInputElement
const launch = byId<HTMLButtonElement>('launch')
const picker = byId<HTMLSelectElement>('wallet-picker')
const connect = byId<HTMLButtonElement>('connect')
const switchNetwork = byId<HTMLButtonElement>('switch-network')
const checkReceipt = byId<HTMLButtonElement>('check-receipt')
const iconInput = byId<HTMLInputElement>('icon')
const iconPreview = byId<HTMLImageElement>('icon-preview')
const prepareMetadata = byId<HTMLButtonElement>('pin-metadata')
const metadataField = form.elements.namedItem('metadata') as HTMLInputElement
const wallets: WalletOption[] = []
const pendingKey = 'launchpilot.creator.pending.v2'
const outcomeKey = 'launchpilot.creator.outcome.v1'
const launchLock = walletActionLock
type Pending = ExpectedLaunch & { hash?: Hex }
type LaunchOutcome = { hash: Hex; token?: Address; metadataURI?: string }
let pending: Pending | undefined
let sending = false
let receiptChecks = 0
let receiptTimer: number | undefined
let connected: { wallet: WalletOption; account?: Address; testnet: boolean } | undefined
let walletRevision = 0
let sampleOnly = false
let icon: File | undefined
let uploadInProgress = false
let pinnedUri: string | undefined
const demo: Fields = {
  name: 'LaunchPilot Example', symbol: 'PILOT',
  metadata: 'ipfs://bafkreiebwetv5nptmdaqojzcf63w3kiawnefeh3xpuog2t7bsaz3pm7ovu',
  sender: '0x75Bf808C9A94AF24829533c468308c36A450DC9a',
  tax: '100', opening: '10000000', cap: '0.01',
  treasury: '20', tokenRewards: '75', burn: '5', ethRewards: '0',
}
let active: AbortController | undefined
let current: Review | undefined
let baseline: Review | undefined
const display = (value: bigint) => `${eth(value)} ETH`
const fields = () => Object.fromEntries(new FormData(form)) as Fields
const hashPattern = /^0x[0-9a-f]{64}$/i
const invalidateBuy = setupBuyPanel(
  () => connected?.testnet && connected.account ? { provider: connected.wallet.provider, account: connected.account } : undefined,
  () => Boolean(loadPending()),
)

function updateLaunch() {
  const canLaunch = current && current.maxTotal <= current.cap && connected?.testnet
    && current.transaction.from.toLowerCase() === connected.account?.toLowerCase()
    && !sampleOnly && !pending && !sending
  launch.disabled = !canLaunch
  if (pending || sending) return
  text('launch-note', sampleOnly ? 'The example is available for simulation only.'
    : current && current.maxTotal > current.cap ? 'Reduce the cost or change the cap before requesting wallet approval.'
    : canLaunch ? 'Your wallet will show the transaction for approval. Review the fee there before confirming.'
    : 'Connect a testnet wallet and review a draft within your cap to open the wallet approval.')
}

function status(label: string, message: string, tone = '') {
  badge.dataset.tone = tone
  text('badge', label)
  text('status', message)
}

function compare() {
  const hasComparison = Boolean(current && baseline)
  byId('deltas').hidden = !hasComparison
  byId('clear').hidden = !baseline
  text('compare', baseline
    ? `Baseline saved at block ${baseline.blockNumber.toLocaleString('en-US')}.`
    : 'Save a reviewed draft, then change the opening allocation or cap and simulate again.')
  if (!current || !baseline) return
  const delta = current.total - baseline.total
  text('old-total', display(baseline.total))
  text('new-total', display(current.total))
  text('delta', `${delta > 0n ? '+' : ''}${display(delta)}`)
  text('old-status', baseline.withinCap ? 'Within cap' : 'Over cap')
}

function clearReview() {
  active?.abort()
  active = undefined
  current = undefined
  run.disabled = false
  pin.disabled = true
  for (const id of ['creation', 'funding', 'gas', 'total', 'max-total', 'limit', 'target']) text(id, '—')
  text('block', 'Estimates can change. The cap applies to this review.')
  compare()
  updateLaunch()
}

function showReview(review: Review) {
  current = review
  text('creation', display(review.creationFee))
  text('funding', display(review.funding))
  text('gas', display(review.networkFee))
  text('total', display(review.total))
  text('max-total', display(review.maxTotal))
  text('limit', display(review.cap))
  text('target', display(review.target))
  text('block', `Simulation at block ${review.blockNumber.toLocaleString('en-US')}. Final costs can change. The cap applies to this review.`)
  status(review.withinCap ? 'Within cap' : 'Over cap', review.withinCap
    ? `Testnet accepted the simulation. Your estimate leaves ${display(review.remaining)} within your cap.`
    : `Testnet accepted the simulation, but the estimate exceeds your cap by ${display(-review.remaining)}. Reduce the opening allocation and try again.`,
  review.withinCap ? 'good' : 'warn')
  pin.disabled = false
  compare()
  updateLaunch()
}

function showSplit() {
  const f = fields()
  const base = Number(f.tax)
  text('split-summary', `Of each taxable trade, ${base * 8 / 1000}% funds the project routes and ${base * 2 / 1000}% goes to the protocol. The tax and split are fixed at launch.`)
}

form.addEventListener('input', () => {
  clearReview()
  showSplit()
  status('Draft changed', 'Run a new simulation to review these settings.')
})

function setIcon(file?: File) {
  if (iconPreview.src.startsWith('blob:')) URL.revokeObjectURL(iconPreview.src)
  icon = file
  iconPreview.hidden = !file
  if (file) iconPreview.src = URL.createObjectURL(file)
  else iconPreview.removeAttribute('src')
  prepareMetadata.disabled = !file || uploadInProgress
}

function metadataIdentity() {
  const f = fields()
  return { name: f.name.trim(), symbol: f.symbol.trim().toUpperCase(), sender: f.sender.trim() }
}

function clearPinnedMetadata() {
  if (pinnedUri && metadataField.value === pinnedUri) {
    metadataField.value = ''
    text('metadata-status', 'The icon or token identity changed. Prepare metadata again.')
  }
  pinnedUri = undefined
  prepareMetadata.textContent = 'Prepare public metadata'
}

async function verifyPinnedMetadata(uri: string, identity: ReturnType<typeof metadataIdentity>) {
  text('metadata-status', 'Files pinned. Checking the public IPFS gateway…')
  try {
    await checkPublicMetadata(uri, identity)
    if (pinnedUri === uri && metadataField.value === uri) {
      text('metadata-status', 'Public IPFS metadata and icon verified. Run a fresh simulation.')
    }
  } catch {
    if (pinnedUri === uri && metadataField.value === uri) {
      text('metadata-status', 'Files pinned and the URI is saved in this draft. Retry the gateway check without uploading again.')
    }
  }
}

iconInput.addEventListener('change', () => {
  clearPinnedMetadata()
  const file = iconInput.files?.[0]
  if (!file || file.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    setIcon()
    text('metadata-status', 'Choose a PNG, JPEG or WebP up to 5 MB.')
    return
  }
  setIcon(file)
  text('metadata-status', 'Icon selected. Prepare public metadata when the token details and sender are ready.')
})
form.addEventListener('input', (event) => {
  const input = event.target as HTMLInputElement
  if (['name', 'symbol', 'sender'].includes(input.name) || input.id === 'description') clearPinnedMetadata()
})

prepareMetadata.addEventListener('click', async () => {
  if (!icon || uploadInProgress) return
  const selected = icon
  const identity = metadataIdentity()
  const description = byId<HTMLInputElement>('description').value.trim()
  if (!identity.name || !/^[A-Z0-9]{1,12}$/.test(identity.symbol) || !isAddress(identity.sender)) {
    text('metadata-status', 'Fill in the name, ticker and testnet sender before preparing metadata.')
    return
  }
  uploadInProgress = true
  prepareMetadata.disabled = true
  clearReview()
  if (pinnedUri && metadataField.value === pinnedUri) {
    try {
      await verifyPinnedMetadata(pinnedUri, identity)
    } finally {
      uploadInProgress = false
      prepareMetadata.disabled = !icon
    }
    return
  }
  const previousUri = metadataField.value
  text('metadata-status', 'Preparing and pinning the icon and token metadata…')
  try {
    const bitmap = await createImageBitmap(selected)
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) {
      bitmap.close()
      throw new Error('The browser could not prepare this icon.')
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85))
    if (!blob || blob.size > 512 * 1024) throw new Error('The icon could not be compressed. Choose a smaller image.')
    const body = new FormData()
    body.set('icon', blob, blob.type === 'image/webp' ? 'icon.webp' : 'icon.png')
    body.set('name', identity.name)
    body.set('symbol', identity.symbol)
    body.set('creator', identity.sender)
    body.set('description', description)
    body.set('width', String(canvas.width))
    body.set('height', String(canvas.height))
    const response = await fetch('/api/metadata', { method: 'POST', body, signal: AbortSignal.timeout(35000) })
    const result = await response.json().catch(() => null)
    if (!response.ok || typeof result?.uri !== 'string' || !ipfsUri.test(result.uri)) {
      throw new Error(result?.error ?? 'IPFS uploads are unavailable. Use an existing metadata URI.')
    }
    if (selected !== icon || JSON.stringify(identity) !== JSON.stringify(metadataIdentity())
      || description !== byId<HTMLInputElement>('description').value.trim() || metadataField.value !== previousUri) {
      throw new Error('The draft changed during the upload. Prepare the current metadata again.')
    }
    pinnedUri = result.uri
    metadataField.value = result.uri
    prepareMetadata.textContent = 'Check public metadata'
    clearReview()
    await verifyPinnedMetadata(result.uri, identity)
  } catch (error) {
    text('metadata-status', error instanceof Error ? error.message : 'Metadata preparation failed.')
  } finally {
    uploadInProgress = false
    prepareMetadata.disabled = !icon
  }
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  clearReview()
  const controller = new AbortController()
  active = controller
  try {
    const draft = readDraft(fields())
    run.disabled = true
    status('Simulating', 'Reading live V6 settings and rehearsing the transaction…')
    const review = await rehearse(draft, rpcClient(controller.signal))
    if (!controller.signal.aborted) showReview(review)
  } catch (error) {
    if (controller.signal.aborted) return
    const rejected = error instanceof RpcError && error.reverted
    status(rejected ? 'Testnet rejected' : 'Review incomplete', rejected
      ? refusalMessage(error)
      : error instanceof Error ? error.message : 'The review could not be completed.', 'warn')
  } finally {
    if (active === controller) {
      active = undefined
      run.disabled = false
    }
  }
})

byId('sample').addEventListener('click', () => {
  sampleOnly = true
  clearPinnedMetadata()
  iconInput.value = ''
  setIcon()
  clearReview()
  for (const [name, value] of Object.entries(demo)) {
    const field = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement
    field.value = value
  }
  byId('sample-note').hidden = false
  showSplit()
  status('Example ready', 'Simulate the example, save it as a baseline and try a smaller opening allocation.')
})
pin.addEventListener('click', () => { baseline = current; compare() })
byId('clear').addEventListener('click', () => { baseline = undefined; compare() })
showSplit()

const scanWallets = discoverWallets((wallet) => {
  if (wallets.some(({ provider }) => provider === wallet.provider)) return
  if (!wallets.length) picker.replaceChildren()
  const option = new Option(wallet.name, String(wallets.length))
  wallets.push(wallet)
  picker.add(option)
})
scanWallets()

const automationCheck = byId<HTMLButtonElement>('automation-check')
automationCheck.addEventListener('click', async () => {
  const wallet = wallets[Number(picker.value)]
  if (!picker.value || !wallet) {
    text('automation-status', 'Select and connect a browser wallet first.')
    return
  }
  automationCheck.disabled = true
  text('automation-status', `Checking ${wallet.name} on Robinhood Testnet…`)
  let timer: number | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error('The wallet did not respond to the read-only check.')), 8000)
    })
    const result = await Promise.race([checkExecutionSupport(wallet.provider), timeout])
    if (wallets[Number(picker.value)] !== wallet) throw new Error('Wallet selection changed. Check again.')
    let detail: string
    if (result.state === 'unsupported') detail = `The wallet does not expose ERC-7715 execution permissions (RPC ${result.code}).`
    else if (result.state === 'wrong-network') detail = 'Switch this wallet to Robinhood Chain Testnet (46630) and check again.'
    else if (result.state === 'changed') detail = 'Wallet account or network changed. Check again.'
    else if (result.state === 'unavailable') detail = `Could not verify execution permission support${result.code === undefined ? '' : ` (RPC ${result.code})`}.`
    else if (result.permissions.length === 0) detail = 'No execution permission types reported for Robinhood Testnet.'
    else {
      const reported = result.permissions.map(({ type, rules }) => `${type} (${rules.join(', ') || 'no rules reported'})`).join('; ')
      detail = `Reported permission types: ${reported.slice(0, 300)}. V6 limits and revocation still need verification.`
    }
    text('automation-status', `${wallet.name} · ${detail} Trades still require wallet approval.`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Check your wallet connection.'
    text('automation-status', `${wallet.name} · ${detail} Trades still require wallet approval.`)
  } finally {
    window.clearTimeout(timer)
    automationCheck.disabled = false
  }
})

async function syncWallet(useAddress: boolean) {
  const revision = ++walletRevision
  const walletState = connected
  if (!walletState) return
  walletState.account = undefined
  walletState.testnet = false
  invalidateBuy()
  switchNetwork.hidden = true
  clearReview()
  status('Review required', 'Run a new simulation after changing the wallet or network.')
  try {
    const provider = walletState.wallet.provider
    const [account, testnet] = await Promise.all([walletAccount(provider), onTestnet(provider)])
    if (revision !== walletRevision) return
    walletState.account = account
    walletState.testnet = testnet
    switchNetwork.hidden = testnet
    if (useAddress) {
      if (senderField.value.toLowerCase() !== account.toLowerCase()) clearPinnedMetadata()
      senderField.value = account
      sampleOnly = false
      if (!byId('sample-note').hidden) {
        const metadata = form.elements.namedItem('metadata') as HTMLInputElement
        if (metadata.value === demo.metadata) metadata.value = ''
        byId('sample-note').hidden = true
      }
    }
    text('wallet-state', testnet ? `Connected on Robinhood Testnet · ${account.slice(0, 6)}…${account.slice(-4)}`
      : 'Connected. Switch to Robinhood Chain Testnet before launching.')
  } catch {
    if (revision === walletRevision) text('wallet-state', 'Wallet account or network is unavailable. Reconnect your wallet.')
  }
  updateLaunch()
}

const walletChanged = () => { void syncWallet(true) }
connect.addEventListener('click', async () => {
  scanWallets()
  const wallet = picker.value ? wallets[Number(picker.value)] : undefined
  if (!wallet) {
    text('wallet-state', 'Install or enable a browser wallet, then try again.')
    return
  }
  connect.disabled = true
  try {
    await walletAccount(wallet.provider, true)
    connected?.wallet.provider.removeListener?.('accountsChanged', walletChanged)
    connected?.wallet.provider.removeListener?.('chainChanged', walletChanged)
    connected = { wallet, testnet: false }
    wallet.provider.on?.('accountsChanged', walletChanged)
    wallet.provider.on?.('chainChanged', walletChanged)
    await syncWallet(true)
  } catch (error) {
    text('wallet-state', walletErrorCode(error) === 4001 ? 'Wallet connection cancelled.' : 'The browser wallet could not be connected.')
  } finally {
    connect.disabled = false
  }
})

switchNetwork.addEventListener('click', async () => {
  if (!connected) return
  switchNetwork.disabled = true
  try {
    await switchToTestnet(connected.wallet.provider)
    await syncWallet(true)
  } catch {
    text('wallet-state', 'Switch to Robinhood Chain Testnet in your wallet to continue.')
  } finally {
    switchNetwork.disabled = false
  }
})

function displayPending(value: Pending | undefined) {
  window.clearTimeout(receiptTimer)
  receiptChecks = 0
  pending = value
  checkReceipt.hidden = !value?.hash
  byId('recover').hidden = !value || Boolean(value.hash)
  const explorer = byId<HTMLAnchorElement>('explorer-link')
  explorer.hidden = !value?.hash
  if (value?.hash) explorer.href = `https://explorer.testnet.chain.robinhood.com/tx/${value.hash}`
  updateLaunch()
}

function savePending(value: Pending | undefined) {
  if (value) localStorage.setItem(pendingKey, JSON.stringify(value))
  else localStorage.removeItem(pendingKey)
  displayPending(value)
}

function showOutcome(outcome: LaunchOutcome) {
  const token = byId<HTMLAnchorElement>('token-link')
  const explorer = byId<HTMLAnchorElement>('explorer-link')
  const metadata = byId<HTMLAnchorElement>('metadata-link')
  explorer.href = `https://explorer.testnet.chain.robinhood.com/tx/${outcome.hash}`
  explorer.hidden = false
  token.hidden = !outcome.token
  metadata.hidden = true
  byId('category-link').hidden = !outcome.token
  if (outcome.token) {
    token.href = `https://testnet.vibevibe.fun/token/${outcome.token}`
    if (typeof outcome.metadataURI === 'string' && ipfsUri.test(outcome.metadataURI)) {
      metadata.href = ipfsHttp(outcome.metadataURI)
      metadata.hidden = false
    }
    text('launch-note', 'Launch confirmed on testnet. Check icon display on the token page and manage categories in Created tokens on Vibe/Vibe.')
  } else {
    text('launch-note', 'The testnet reverted the launch. Review a fresh draft before trying again.')
  }
}

function finishLaunch(outcome: LaunchOutcome) {
  localStorage.setItem(outcomeKey, JSON.stringify(outcome))
  savePending(undefined)
  clearReview()
  showOutcome(outcome)
}

function loadPending(): Pending | undefined {
  const raw = localStorage.getItem(pendingKey) ?? sessionStorage.getItem('launchpilot.creator.pending.v1')
  if (!raw) return
  const saved = JSON.parse(raw) as Pending
  if (!saved || !isAddress(saved.sender) || typeof saved.metadataURI !== 'string'
    || !/^0x24e615b3(?:[0-9a-f]{2})+$/i.test(saved.data) || !/^0x[0-9a-f]+$/i.test(saved.value)
    || (saved.hash && !hashPattern.test(saved.hash))) {
    throw new Error('Pending launch data could not be read. Check your wallet history before attempting another launch.')
  }
  return saved
}

async function withLaunchLock(action: () => void | Promise<void>) {
  if (!navigator.locks) {
    text('launch-note', 'Launch approval requires a secure browser with cross-tab transaction locks.')
    return
  }
  try {
    await navigator.locks.request(launchLock, { ifAvailable: true }, async (lock) => {
      if (lock) await action()
      else text('launch-note', 'Another LaunchPilot tab is handling a wallet request. Finish that request first.')
    })
  } catch (error) {
    text('launch-note', error instanceof Error ? error.message : 'The launch state could not be saved.')
  }
}

async function refreshReceipt() {
  const entry = pending
  if (!entry?.hash || checkReceipt.disabled) return
  const hash = entry.hash
  checkReceipt.disabled = true
  try {
    const receipt = await readLaunchReceipt(rpcClient(), hash, entry)
    if (pending !== entry) return
    if (receipt.state === 'pending') {
      text('launch-note', 'Transaction submitted. Waiting for a testnet receipt.')
      if (++receiptChecks < 10) receiptTimer = window.setTimeout(() => { void refreshReceipt() }, 5000)
      return
    }
    await withLaunchLock(() => {
      const saved = loadPending()
      if (pending !== entry || !saved || saved.hash !== hash || saved.data !== entry.data) return
      if (receipt.state === 'confirmed' || receipt.state === 'reverted') {
        finishLaunch(receipt.state === 'confirmed'
          ? { hash, token: receipt.token, metadataURI: entry.metadataURI }
          : { hash })
      } else {
        const { sender, metadataURI, data, value } = entry
        savePending({ sender, metadataURI, data, value })
        text('launch-note', 'This receipt could not be matched to the draft. Verify it in the explorer before retrying.')
      }
    })
  } catch {
    text('launch-note', 'Could not verify the receipt yet. Check again or open the explorer.')
  } finally {
    checkReceipt.disabled = false
  }
}

launch.addEventListener('click', async () => {
  if (launch.disabled || sending || pending || !current || !connected) return
  await withLaunchLock(submitLaunch)
})

async function submitLaunch() {
  if (launch.disabled || sending || pending || !current || !connected) return
  const reviewed = current
  const { wallet } = connected
  sending = true
  updateLaunch()
  byId('token-link').hidden = true
  byId('metadata-link').hidden = true
  byId('category-link').hidden = true
  let requested = false
  try {
    const previousSubmission = loadPending()
    if (localStorage.getItem(tradePendingKey)) {
      clearReview()
      text('launch-note', 'Resolve the pending testnet trade before opening another wallet request.')
      return
    }
    if (previousSubmission) {
      displayPending(previousSubmission)
      text('launch-note', 'Check the existing testnet submission before launching again.')
      return
    }
    const draft = readDraft(fields())
    const draftSignature = JSON.stringify(fields())
    text('launch-note', 'Verifying your public metadata and refreshing the testnet estimate…')
    await checkPublicMetadata(draft.metadataURI, draft)
    const rpc = rpcClient()
    const fresh = await rehearse(draft, rpc)
    const balance = quantity(await rpc('eth_getBalance', [draft.sender, 'pending']))
    const [account, correctNetwork] = await Promise.all([walletAccount(wallet.provider), onTestnet(wallet.provider)])
    if (!correctNetwork || account.toLowerCase() !== draft.sender.toLowerCase() || reviewed !== current
      || connected?.wallet !== wallet || draftSignature !== JSON.stringify(fields())) {
      throw new Error('The draft, connected account or network changed. Review again before launching.')
    }
    const transaction = reviewForWallet(reviewed, fresh, balance)
    const entry = { sender: draft.sender, metadataURI: draft.metadataURI, data: transaction.data, value: transaction.value }
    localStorage.removeItem(outcomeKey)
    savePending(entry)
    byId('recover').hidden = true
    text('launch-note', 'Review and confirm the launch in your wallet.')
    requested = true
    const hash = await wallet.provider.request({ method: 'eth_sendTransaction', params: [transaction] })
    if (typeof hash !== 'string' || !hashPattern.test(hash)) throw new Error('Unknown wallet response.')
    savePending({ ...entry, hash: hash as Hex })
    text('launch-note', 'Transaction submitted. Waiting for a testnet receipt.')
    window.setTimeout(() => { void refreshReceipt() }, 1000)
  } catch (error) {
    if (requested && walletErrorCode(error) === 4001) {
      savePending(undefined)
      clearReview()
      text('launch-note', 'Wallet approval cancelled. Rehearse again when you are ready.')
    } else if (requested && pending) {
      byId('recover').hidden = false
      text('launch-note', 'Submission could not be confirmed. Check your wallet history before trying again.')
    } else {
      clearReview()
      text('launch-note', error instanceof Error ? error.message : 'Launch preparation failed. Review again.')
    }
  } finally {
    sending = false
    launch.disabled = true
  }
}

checkReceipt.addEventListener('click', () => { void refreshReceipt() })
byId('recover-submit').addEventListener('click', () => { void withLaunchLock(() => {
  const hash = byId<HTMLInputElement>('recover-hash').value.trim()
  const saved = loadPending()
  if (!saved || !hashPattern.test(hash)) {
    text('launch-note', 'Enter a transaction hash from your wallet history.')
    return
  }
  savePending({ ...saved, hash: hash as Hex })
  window.setTimeout(() => { void refreshReceipt() }, 1000)
}) })
byId('recover-clear').addEventListener('click', () => { void withLaunchLock(() => {
  if (loadPending()?.hash) return
  savePending(undefined)
  clearReview()
  text('launch-note', 'Recovery cleared. Rehearse a fresh draft before submitting.')
}) })
function syncPending() {
  try {
    const saved = loadPending()
    displayPending(saved)
    if (!saved) {
      const outcome = JSON.parse(localStorage.getItem(outcomeKey) ?? 'null') as LaunchOutcome | null
      if (outcome && hashPattern.test(outcome.hash) && (!outcome.token || isAddress(outcome.token))) showOutcome(outcome)
      return
    }
    byId('token-link').hidden = true
    byId('metadata-link').hidden = true
    byId('category-link').hidden = true
    text('launch-note', saved.hash ? 'Checking a previous submission.' : 'Check your wallet history to recover the previous submission.')
    if (saved.hash) void refreshReceipt()
  } catch (error) {
    launch.disabled = true
    text('launch-note', error instanceof Error ? error.message : 'Pending launch state is unavailable.')
  }
}
window.addEventListener('storage', (event) => {
  if (event.key !== pendingKey) return
  if (!event.newValue) clearReview()
  syncPending()
})
try {
  const legacy = sessionStorage.getItem('launchpilot.creator.pending.v1')
  if (legacy) {
    void withLaunchLock(() => {
      const saved = loadPending()
      if (saved) savePending(saved)
      sessionStorage.removeItem('launchpilot.creator.pending.v1')
      syncPending()
    })
  } else syncPending()
} catch {
  // A wallet request is refused if the pending launch cannot be persisted.
}
