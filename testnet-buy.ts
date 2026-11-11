import {
  decodeEventLog, decodeFunctionResult, encodeFunctionData, isAddress, parseAbi, toHex, zeroAddress,
  type Address, type Hex,
} from 'viem'
import { paperEntry, paperMarket, requireFreshQuote } from './paper-trade.ts'
import { amount, quantity, rpcClient } from './protocol.ts'

export const tradePendingKey = 'launchpilot.testnet-buy.pending.v1'
export const executionZap = '0xe1F8ca47E43f79248fEb529411Ba64795d628eB0'
export const transactionHashPattern = /^0x[0-9a-f]{64}$/i
const abi = parseAbi([
  'function buy(address curve, address input, uint256 amountIn, (address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)[] path, uint256 minTokensOut, uint256 deadline, bytes permit, (address token,uint256 minPending)[] claims) payable returns (uint256 pairIn)',
  'event CurveBuy(address indexed buyer,address indexed recipient,uint256 grossTokens,uint256 netTokens,uint256 tokenFee,uint256 pairCost,uint256 pairFee,uint256 rateBps)',
])
type Rpc = ReturnType<typeof rpcClient>
export type TradeCall = { from: Address; to: Address; data: Hex; value: Hex }
export type TradeTransaction = TradeCall & { gas: Hex; gasPrice: Hex }

export async function estimateTrade(call: TradeCall, pin: Hex, timestamp: bigint, gasPrice: bigint, rpc: Rpc) {
  const [estimate, balance] = await Promise.all([
    rpc('eth_estimateGas', [call, pin]), rpc('eth_getBalance', [call.from, 'pending']),
  ])
  requireFreshQuote(timestamp)
  const gasUnits = quantity(estimate)
  if (gasUnits <= 0n) throw new Error('The network did not return a gas estimate.')
  const gas = (gasUnits * 115n + 99n) / 100n
  const gasCost = gas * gasPrice
  return { gasCost, balance: quantity(balance), transaction: { ...call, gas: toHex(gas), gasPrice: toHex(gasPrice) } }
}

export function readBuy(form: FormData) {
  const field = (name: string) => String(form.get(name) ?? '').trim()
  const token = field('token')
  if (!isAddress(token, { strict: false }) || token.toLowerCase() === zeroAddress) throw new Error('Enter a valid V6 token address.')
  const size = amount(field('size'), 'Buy size')
  const cap = amount(field('cap'), 'Total spend cap')
  const age = amount(field('age'), 'Max token age', 0)
  const tax = amount(field('tax'), 'Max tax', 2)
  const impact = amount(field('impact'), 'Max price impact', 2)
  const slippage = amount(field('slippage'), 'Slippage allowance', 2)
  if (size <= 0n || cap <= size || age <= 0n || tax > 10000n || impact > 10000n || slippage >= 10000n) {
    throw new Error('Use a positive size, a cap above the size and valid age and percentage limits.')
  }
  return { token: token as Address, size, cap, age, tax, impact, slippage }
}

export async function reviewBuy(
  draft: ReturnType<typeof readBuy>, from: Address, rpc: Rpc, previous?: { minOut: bigint; total: bigint; curve: Address },
) {
  const market = await paperMarket(draft.token, 'buy', rpc)
  if (previous && market.curve !== previous.curve) throw new Error('The token curve changed. Review again.')
  const quote = await paperEntry(draft, { ...market, fee: 0n })
  const minOut = previous?.minOut ?? quote.tokens
  if (quote.out < minOut) throw new Error('The refreshed quote no longer meets the reviewed minimum. Review again.')
  const deadline = market.timestamp + 120n
  const pin = toHex(market.number)
  const data = encodeFunctionData({
    abi, functionName: 'buy', args: [market.curve, zeroAddress, draft.size, [], minOut, deadline, '0x', []],
  })
  const call: TradeCall = { from, to: executionZap, data, value: toHex(draft.size) }
  const simulated = await rpc('eth_call', [call, pin])
  const pairIn = decodeFunctionResult({ abi, functionName: 'buy', data: simulated as Hex })
  if (pairIn !== draft.size) throw new Error('The zap returned an unexpected ETH input.')
  const { gasCost, balance, transaction } = await estimateTrade(call, pin, market.timestamp, market.gasPrice, rpc)
  const total = draft.size + gasCost
  if (total > draft.cap) throw new Error('Buy plus the estimated gas reserve exceeds your cap.')
  if (total > balance) throw new Error('The connected account cannot cover the buy and gas reserve.')
  if (previous && total > previous.total) throw new Error('The refreshed cost increased. Review again before opening your wallet.')
  return {
    ...quote, minOut, deadline, gasCost, total, curve: market.curve,
    transaction,
  }
}

export type BuyReview = Awaited<ReturnType<typeof reviewBuy>>
export type PendingBuy = { transaction: BuyReview['transaction']; curve: Address; hash?: Hex }

export function restoreBuy(raw: string | null): PendingBuy | undefined {
  if (raw === null) return
  const saved = JSON.parse(raw) as PendingBuy
  const tx = saved?.transaction
  if (!tx || !isAddress(tx.from, { strict: false }) || tx.to !== executionZap
    || typeof tx.data !== 'string' || !/^0x(?:[0-9a-f]{2}){4,}$/i.test(tx.data)
    || !isAddress(saved.curve, { strict: false })
    || (saved.hash !== undefined && (typeof saved.hash !== 'string' || !transactionHashPattern.test(saved.hash)))) {
    throw new Error('Saved buy could not be read. Check your wallet history.')
  }
  for (const value of [tx.value, tx.gas, tx.gasPrice]) if (quantity(value) <= 0n) throw new Error('Saved buy amounts are invalid.')
  return saved
}

export async function matchTradeReceipt(tx: TradeTransaction, hash: Hex, rpc: Rpc) {
  const receipt = await rpc('eth_getTransactionReceipt', [hash]) as {
    status?: Hex; from?: string; to?: string; gasUsed?: Hex; effectiveGasPrice?: Hex; blockNumber?: Hex
    logs?: { address: string; data: Hex; topics: [Hex, ...Hex[]] }[]
  } | null
  if (!receipt) return { state: 'pending' } as const
  if (receipt.from?.toLowerCase() !== tx.from.toLowerCase() || receipt.to?.toLowerCase() !== tx.to.toLowerCase()) {
    return { state: 'unverified' } as const
  }
  const published = await rpc('eth_getTransactionByHash', [hash]) as { input?: Hex; value?: Hex } | null
  if (!published?.input || !published.value) return { state: 'pending' } as const
  if (published.input.toLowerCase() !== tx.data.toLowerCase() || quantity(published.value) !== quantity(tx.value)) {
    return { state: 'unverified' } as const
  }
  if (receipt.status === '0x0') return { state: 'reverted' } as const
  if (receipt.status !== '0x1') return { state: 'unverified' } as const
  return { state: 'matched', receipt } as const
}

export async function buyReceipt(pending: PendingBuy, hash: Hex, rpc: Rpc) {
  const result = await matchTradeReceipt(pending.transaction, hash, rpc)
  if (result.state !== 'matched') return result
  const { receipt } = result
  for (const log of receipt.logs ?? []) {
    if (log.address.toLowerCase() !== pending.curve.toLowerCase()) continue
    try {
      const { args } = decodeEventLog({ abi, eventName: 'CurveBuy', data: log.data, topics: log.topics })
      if (args.recipient.toLowerCase() === pending.transaction.from.toLowerCase() && args.netTokens > 0n) {
        const gasCost = quantity(receipt.gasUsed) * quantity(receipt.effectiveGasPrice)
        return { state: 'confirmed', tokens: args.netTokens, gasCost } as const
      }
    } catch {
      // Other logs from the curve do not verify a buy.
    }
  }
  return { state: 'unverified' } as const
}
