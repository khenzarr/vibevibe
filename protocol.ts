import {
  decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeFunctionData, formatUnits, isAddress, parseAbi, parseAbiItem,
  toHex, zeroAddress, zeroHash, type Address, type Hex,
} from 'viem'
import { ipfsUri } from './metadata.ts'

export const factory = '0xac135dA186de8325047eF2AfD1d16D5971F731f7'
const pairPolicy = '0xb5F599ca14341441CcdEE88f650c2F754B4be0db'
const hook = '0xE61e46724BA5DEC31f2be031106558774A65e8ec'
const rpcUrl = 'https://rpc.testnet.chain.robinhood.com'
const supply = 1_000_000_000n * 10n ** 18n
const taxScale = 10n ** 12n
export const launchCreated = parseAbiItem('event LaunchCreated(uint256 indexed launchId, address indexed launcher, address indexed token, address curve, string name, string symbol, string metadataURI, address pairCurrency, uint16 taxBps, uint64 packedWeights, address projectTreasury, uint256 targetPairUnits, uint256 netPersonal, uint256 giftNetTotal, bytes32 giftRoot, uint256 giftCount)')
const abi = parseAbi([
  'function launchEnabled() view returns (bool)',
  'function creationFee() view returns (uint256)',
  'function targetFor(address pair) view returns (uint256)',
  'function hook() view returns (address)',
  'function targetOracle() view returns (address)',
  'function createToken((string name,string symbol,string metadataURI,uint16 taxBps,uint64 packedWeights,address projectTreasury,address pairCurrency,uint256 netPersonal,uint256 giftList,bytes32 giftRoot,uint256 deadline,uint256 permitDeadline,uint8 permitV,bytes32 permitR,bytes32 permitS) params) payable returns (address token,address curve)',
  'error InsufficientValue()',
  'error InvalidMetadata()',
  'error InitialCapExceeded()',
])

export type Fields = Record<'name' | 'symbol' | 'metadata' | 'sender' | 'tax' | 'opening' | 'cap' | 'treasury' | 'tokenRewards' | 'burn' | 'ethRewards', string>
export type Draft = ReturnType<typeof readDraft>
export type Review = Awaited<ReturnType<typeof rehearse>>
type Rpc = (method: string, params?: unknown[]) => Promise<unknown>

export function amount(value: string, label: string, decimals = 18) {
  const match = /^(\d{1,18})(?:\.(\d+))?$/.exec(value.trim())
  if (!match || (match[2]?.length ?? 0) > decimals) {
    throw new Error(`${label}: enter a number with up to ${decimals} decimal places.`)
  }
  const [, whole, fraction = ''] = match
  return BigInt(whole + fraction.padEnd(decimals, '0'))
}

export function openingFunding(netTokens: bigint, target: bigint, taxBps: number, weights: readonly bigint[]) {
  if (netTokens === 0n) return 0n
  const [treasury, tokenRewards, burn, ethRewards] = weights
  const tokenTax = BigInt(taxBps) * 8000n * (tokenRewards + burn)
  const ethTax = BigInt(taxBps) * (2000n * 10000n + 8000n * (treasury + ethRewards))
  const grossTokens = (netTokens - 1n) * taxScale / (taxScale - tokenTax) + 1n
  if (grossTokens > supply / 2n) throw new Error('Opening allocation exceeds 50% of the total supply after tax.')
  const curveCost = (5n * target * grossTokens - 1n) / (16n * supply - 15n * grossTokens) + 1n
  return curveCost + curveCost * ethTax / taxScale
}

export function readDraft(fields: Fields) {
  const name = fields.name.trim()
  const symbol = fields.symbol.trim().toUpperCase()
  const metadataURI = fields.metadata.trim()
  const sender = fields.sender.trim()
  if (!name || new TextEncoder().encode(name).length > 64) throw new Error('Enter a token name of up to 64 UTF-8 bytes.')
  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) throw new Error('Use 1–12 letters or digits in the ticker.')
  if (!ipfsUri.test(metadataURI)) throw new Error('Enter a public IPFS metadata URI with a valid CID format.')
  if (!isAddress(sender, { strict: false }) || sender.toLowerCase() === zeroAddress) throw new Error('Enter a nonzero testnet sender address.')
  const taxBps = Number(fields.tax)
  if (![100, 200, 300].includes(taxBps)) throw new Error('Select a supported base tax.')
  const weights = [
    amount(fields.treasury, 'Project treasury', 2), amount(fields.tokenRewards, 'Token rewards', 2),
    amount(fields.burn, 'Token burn', 2), amount(fields.ethRewards, 'ETH rewards', 2),
  ]
  if (weights.reduce((sum, weight) => sum + weight, 0n) !== 10000n) throw new Error('The four project allocations must add up to 100%.')
  const netTokens = amount(fields.opening, 'Opening allocation')
  const cap = amount(fields.cap, 'Spend cap')
  return { name, symbol, metadataURI, sender: sender as Address, taxBps, weights, netTokens, cap }
}

export function budget(creationFee: bigint, funding: bigint, gas: bigint, gasPrice: bigint, cap: bigint) {
  if (creationFee < 0n || funding < 0n || gas <= 0n || gasPrice <= 0n || cap < 0n) {
    throw new Error('A complete network cost estimate is required.')
  }
  const networkFee = gas * gasPrice
  const total = creationFee + funding + networkFee
  return { creationFee, funding, networkFee, total, cap, remaining: cap - total, withinCap: total <= cap }
}

export class RpcError extends Error {
  readonly data?: unknown
  readonly reverted: boolean

  constructor(message: string, data?: unknown, reverted = false) {
    super(message)
    this.data = data
    this.reverted = reverted
  }
}

export function refusalMessage(error: RpcError) {
  if (typeof error.data === 'string' && /^0x[0-9a-f]{8,}$/i.test(error.data)) {
    try {
      const { errorName } = decodeErrorResult({ abi, data: error.data as Hex })
      if (errorName === 'InsufficientValue') return 'V6 refused the attached ETH. Refresh the estimate and try again.'
      if (errorName === 'InvalidMetadata') return 'V6 refused the metadata URI. Check that it uses a supported IPFS CID.'
      if (errorName === 'InitialCapExceeded') return 'The opening allocation exceeds the V6 limit after tax.'
    } catch {
      // The factory can return errors outside the supported preview ABI.
    }
  }
  return 'The testnet rejected this draft. Check the sender balance, metadata URI and opening allocation.'
}

export function rpcClient(signal?: AbortSignal): Rpc {
  return async (method, params = []) => {
    const timeout = AbortSignal.timeout(15000)
    let response: Response
    try {
      response = await fetch(rpcUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch {
      throw new RpcError('The Robinhood testnet did not respond. Try again.')
    }
    if (!response.ok) throw new RpcError(`Testnet request failed (HTTP ${response.status}). Try again.`)
    const payload = await response.json()
    if (payload.error) {
      const message = String(payload.error.message ?? 'RPC error')
      throw new RpcError(message, payload.error.data, payload.error.code === 3 || /revert/i.test(message))
    }
    if (!Object.hasOwn(payload, 'result')) throw new RpcError('The testnet returned an incomplete response.')
    return payload.result
  }
}

export function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new RpcError('Invalid numeric response from testnet.')
  return BigInt(value)
}

export async function rehearse(draft: Draft, rpc: Rpc) {
  if (quantity(await rpc('eth_chainId')) !== 46630n) throw new Error('Wrong network. This app requires Robinhood Chain Testnet (46630).')
  const block = await rpc('eth_getBlockByNumber', ['latest', false]) as { number?: Hex; timestamp?: Hex } | null
  const blockNumber = quantity(block?.number)
  const timestamp = quantity(block?.timestamp)
  const pin = toHex(blockNumber)
  async function read(functionName: 'creationFee' | 'launchEnabled' | 'hook' | 'targetOracle') {
    const data = encodeFunctionData({ abi, functionName })
    return await rpc('eth_call', [{ to: factory, data }, pin]) as Hex
  }
  const targetData = encodeFunctionData({ abi, functionName: 'targetFor', args: [zeroAddress] })
  const [hookResult, policyResult, enabledResult, feeResult, targetResult] = await Promise.all([
    read('hook'), read('targetOracle'), read('launchEnabled'), read('creationFee'),
    rpc('eth_call', [{ to: pairPolicy, data: targetData }, pin]),
  ])
  const liveHook = decodeFunctionResult({ abi, functionName: 'hook', data: hookResult })
  const livePolicy = decodeFunctionResult({ abi, functionName: 'targetOracle', data: policyResult })
  const enabled = decodeFunctionResult({ abi, functionName: 'launchEnabled', data: enabledResult })
  const creationFee = decodeFunctionResult({ abi, functionName: 'creationFee', data: feeResult })
  if (liveHook.toLowerCase() !== hook.toLowerCase() || livePolicy.toLowerCase() !== pairPolicy.toLowerCase()) {
    throw new Error('The configured V6 deployment could not be verified.')
  }
  if (!enabled) throw new Error('Token creation is currently disabled on this V6 deployment.')
  const target = decodeFunctionResult({ abi, functionName: 'targetFor', data: targetResult as Hex })
  if (target <= 0n) throw new Error('The ETH graduation target is unavailable.')
  const funding = openingFunding(draft.netTokens, target, draft.taxBps, draft.weights)
  const packedWeights = draft.weights.reduce((packed, weight, index) => packed | (weight << BigInt(index * 16)), 0n)
  const data = encodeFunctionData({
    abi, functionName: 'createToken', args: [{
      name: draft.name, symbol: draft.symbol, metadataURI: draft.metadataURI,
      taxBps: draft.taxBps, packedWeights, projectTreasury: draft.sender, pairCurrency: zeroAddress,
      netPersonal: draft.netTokens, giftList: 0n, giftRoot: zeroHash, deadline: timestamp + 600n,
      permitDeadline: 0n, permitV: 0, permitR: zeroHash, permitS: zeroHash,
    }],
  })
  const transaction = { from: draft.sender, to: factory, data, value: toHex(creationFee + funding) }
  const result = await rpc('eth_call', [transaction, pin]) as Hex
  const [token, curve] = decodeFunctionResult({ abi, functionName: 'createToken', data: result })
  if (token === zeroAddress || curve === zeroAddress) throw new Error('The V6 factory returned an incomplete simulation.')
  const [gas, gasPrice] = await Promise.all([
    rpc('eth_estimateGas', [transaction, pin]), rpc('eth_gasPrice'),
  ])
  const gasUnits = quantity(gas)
  const price = quantity(gasPrice)
  const gasLimit = (gasUnits * 115n + 99n) / 100n
  return {
    ...budget(creationFee, funding, gasUnits, price, draft.cap), blockNumber, target,
    maxTotal: creationFee + funding + gasLimit * price,
    transaction: { ...transaction, gas: toHex(gasLimit), gasPrice: toHex(price) },
  }
}

export function reviewForWallet(previous: Review, fresh: Review, balance: bigint) {
  if (fresh.maxTotal > fresh.cap) throw new Error('The refreshed cost including the gas reserve exceeds your cap. Review a smaller draft.')
  if (fresh.maxTotal > previous.maxTotal || fresh.transaction.value !== previous.transaction.value || fresh.target !== previous.target) {
    throw new Error('The launch cost or target changed. Review the refreshed estimate before opening your wallet.')
  }
  if (balance < fresh.maxTotal) throw new Error('The connected testnet account cannot cover the launch and gas reserve.')
  return fresh.transaction
}

export interface ExpectedLaunch {
  sender: Address
  metadataURI: string
  data: Hex
  value: Hex
}

export async function readLaunchReceipt(rpc: Rpc, hash: Hex, expected: ExpectedLaunch) {
  const result = await rpc('eth_getTransactionReceipt', [hash]) as {
    status?: string
    from?: string
    to?: string
    logs?: { address: string; data: Hex; topics: [Hex, ...Hex[]] }[]
  } | null
  if (!result) return { state: 'pending' } as const
  if (result.from?.toLowerCase() !== expected.sender.toLowerCase() || result.to?.toLowerCase() !== factory.toLowerCase()) {
    return { state: 'unverified' } as const
  }
  const transaction = await rpc('eth_getTransactionByHash', [hash]) as { input?: string; value?: Hex } | null
  if (!transaction?.input || !transaction.value) return { state: 'pending' } as const
  if (transaction.input.toLowerCase() !== expected.data.toLowerCase() || quantity(transaction.value) !== quantity(expected.value)) {
    return { state: 'unverified' } as const
  }
  if (result.status === '0x0') return { state: 'reverted' } as const
  if (result.status === '0x1') {
    for (const log of result.logs ?? []) {
      if (log.address.toLowerCase() !== factory.toLowerCase()) continue
      try {
        const { args } = decodeEventLog({ abi: [launchCreated], eventName: 'LaunchCreated', data: log.data, topics: log.topics })
        if (args.launcher.toLowerCase() === expected.sender.toLowerCase() && args.metadataURI === expected.metadataURI) {
          return { state: 'confirmed', token: args.token } as const
        }
      } catch {
        // A factory receipt can contain events other than LaunchCreated.
      }
    }
  }
  return { state: 'unverified' } as const
}

export const eth = (value: bigint) => formatUnits(value, 18)
