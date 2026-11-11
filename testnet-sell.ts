import { decodeEventLog, decodeFunctionResult, encodeFunctionData, isAddress, parseAbi, toHex, zeroAddress, type Address, type Hex } from 'viem'
import { minimumOut, paperMarket } from './paper-trade.ts'
import { amount, quantity, rpcClient } from './protocol.ts'
import { estimateTrade, executionZap, matchTradeReceipt, transactionHashPattern, type TradeCall, type TradeTransaction } from './testnet-buy.ts'

const abi = parseAbi([
  'function allowance(address owner,address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender,uint256 value) returns (bool)',
  'function sell(address curve,uint256 grossTokens,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)[] path,uint256 minOut,uint256 deadline,(address token,uint256 minPending)[] claims) returns (uint256 amountOut)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event Zapped(address indexed actor,uint8 kind,address indexed market,address input,address output,uint256 amountIn,uint256 amountOut)',
])
type Rpc = ReturnType<typeof rpcClient>
export type PendingSell = {
  kind: 'approval' | 'sell'; token: Address; curve: Address; size: string; minimum: string;
  transaction: TradeTransaction; hash?: Hex;
}
const same = (first: string, second: string) => first.toLowerCase() === second.toLowerCase()

export function readSell(form: FormData) {
  const field = (name: string) => String(form.get(name) ?? '').trim()
  const token = field('token')
  if (!isAddress(token, { strict: false }) || same(token, zeroAddress)) throw new Error('Enter a valid V6 token address.')
  const size = amount(field('sellSize'), 'Token amount')
  const cap = amount(field('sellCap'), 'Gas cap')
  const slippage = amount(field('slippage'), 'Slippage allowance', 2)
  if (size <= 0n || cap <= 0n || slippage >= 10000n) throw new Error('Use a positive token amount and gas cap, and slippage below 100%.')
  return { token: token as Address, size, cap, slippage }
}

async function tokenRead(rpc: Rpc, token: Address, owner: Address, pin: Hex, name: 'allowance' | 'balanceOf'): Promise<bigint> {
  const data = name === 'allowance'
    ? encodeFunctionData({ abi, functionName: 'allowance', args: [owner, executionZap] })
    : encodeFunctionData({ abi, functionName: 'balanceOf', args: [owner] })
  return decodeFunctionResult({ abi, functionName: name, data: await rpc('eth_call', [{ to: token, data }, pin]) as Hex }) as bigint
}

export async function reviewSell(
  draft: ReturnType<typeof readSell>, from: Address, rpc: Rpc,
  previous?: { kind: PendingSell['kind']; minOut: bigint; gasCost: bigint; curve: Address },
) {
  const market = await paperMarket(draft.token, 'sell', rpc)
  const pin = toHex(market.number)
  const [held, allowance] = await Promise.all([
    tokenRead(rpc, draft.token, from, pin, 'balanceOf'), tokenRead(rpc, draft.token, from, pin, 'allowance'),
  ])
  if (held < draft.size) throw new Error('The connected wallet does not hold enough tokens to sell.')
  const kind = allowance < draft.size ? 'approval' : 'sell'
  if (previous && (kind !== previous.kind || !same(market.curve, previous.curve))) throw new Error('Allowance or curve changed. Review again.')
  const [, , , out] = await market.sell(draft.size)
  const minOut = previous?.minOut ?? minimumOut(out, draft.slippage)
  if (minOut <= 0n || out < minOut) throw new Error('The sale does not meet the reviewed minimum ETH output.')
  const deadline = market.timestamp + 120n
  const call: TradeCall = {
    from, to: kind === 'approval' ? draft.token : executionZap, value: '0x0',
    data: kind === 'approval' ? encodeFunctionData({ abi, functionName: 'approve', args: [executionZap, draft.size] })
      : encodeFunctionData({ abi, functionName: 'sell', args: [market.curve, draft.size, [], minOut, deadline, []] }),
  }
  const simulated = await rpc('eth_call', [call, pin]) as Hex
  if (kind === 'approval') {
    if (!decodeFunctionResult({ abi, functionName: 'approve', data: simulated })) throw new Error('The token refused the exact allowance.')
  } else if (decodeFunctionResult({ abi, functionName: 'sell', data: simulated }) < minOut) {
    throw new Error('The simulated sale returned less than the reviewed minimum.')
  }
  const { transaction, gasCost, balance } = await estimateTrade(call, pin, market.timestamp, market.gasPrice, rpc)
  if (gasCost > draft.cap || gasCost > balance) throw new Error('Gas reserve exceeds the cap or available test ETH.')
  if (previous && gasCost > previous.gasCost) throw new Error('Gas cost increased. Review again before opening the wallet.')
  if (kind === 'sell' && gasCost >= minOut) throw new Error('Gas reserve consumes the minimum sale proceeds.')
  return { kind: kind as PendingSell['kind'], transaction, gasCost, block: market.number, curve: market.curve, minOut, out, deadline, held, allowance }
}

export function restoreSell(raw: unknown): PendingSell {
  const entry = raw as PendingSell
  const tx = entry?.transaction
  if (!tx || (entry.kind !== 'approval' && entry.kind !== 'sell') || !isAddress(entry.token, { strict: false })
    || !isAddress(entry.curve, { strict: false }) || !isAddress(tx.from, { strict: false })
    || typeof tx.to !== 'string' || !same(tx.to, entry.kind === 'approval' ? entry.token : executionZap)
    || typeof tx.data !== 'string' || !/^0x(?:[0-9a-f]{2}){4,}$/i.test(tx.data)
    || !/^\d{1,80}$/.test(entry.size) || BigInt(entry.size) <= 0n
    || !/^\d{1,80}$/.test(entry.minimum) || BigInt(entry.minimum) <= 0n
    || quantity(tx.value) !== 0n || quantity(tx.gas) <= 0n || quantity(tx.gasPrice) <= 0n
    || (entry.hash !== undefined && !transactionHashPattern.test(entry.hash))) throw new Error('Invalid saved testnet sale.')
  return entry
}

export async function sellReceipt(entry: PendingSell, hash: Hex, rpc: Rpc) {
  const matched = await matchTradeReceipt(entry.transaction, hash, rpc)
  if (matched.state !== 'matched') return matched
  const { receipt } = matched
  const account = entry.transaction.from
  const size = BigInt(entry.size)
  let approval = false
  let amountOut: bigint | undefined
  let debited = 0n
  for (const log of receipt.logs ?? []) {
    try {
      const { eventName, args } = decodeEventLog({ abi, data: log.data, topics: log.topics })
      if (eventName === 'Approval' && same(log.address, entry.token)) {
        if (same(args.owner, account) && same(args.spender, executionZap) && args.value === size) approval = true
      }
      if (eventName === 'Transfer' && same(log.address, entry.token)) {
        if (same(args.from, account)) debited += args.value
        if (same(args.to, account)) debited -= args.value
      }
      if (eventName === 'Zapped' && same(log.address, executionZap) && same(args.actor, account)
        && same(args.market, entry.curve) && same(args.input, entry.token) && same(args.output, zeroAddress) && args.amountIn === size) {
        amountOut = args.amountOut
      }
    } catch {
      // Other events do not reconcile the trade.
    }
  }
  const pin = toHex(quantity(receipt.blockNumber))
  const gasCost = quantity(receipt.gasUsed) * quantity(receipt.effectiveGasPrice)
  if (entry.kind === 'approval' && approval && await tokenRead(rpc, entry.token, account, pin, 'allowance') === size) {
    return { state: 'approved', gasCost } as const
  }
  if (entry.kind === 'sell' && debited === size && amountOut !== undefined && amountOut >= BigInt(entry.minimum)) {
    const balance = await tokenRead(rpc, entry.token, account, pin, 'balanceOf')
    return { state: 'sold', size, amountOut, gasCost, balance } as const
  }
  return { state: 'unverified' } as const
}
