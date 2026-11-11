import { decodeEventLog, encodeEventTopics, isAddress, toHex, zeroAddress, type Hex } from 'viem'
import { factory, launchCreated, quantity, rpcClient } from './protocol.ts'

const topics = encodeEventTopics({ abi: [launchCreated], eventName: 'LaunchCreated' })
const hashPattern = /^0x[0-9a-f]{64}$/i
export const watchKey = `launchpilot.watch.46630.${factory.toLowerCase()}`

export interface LaunchRow {
  token: string
  name: string
  symbol: string
  block: string
  hash: string
  ethPair: boolean
  taxBps: number
}

export interface WatchState {
  nextBlock: string
  rows: LaunchRow[]
}

interface ChainLog {
  address: string
  blockNumber: Hex
  logIndex: Hex
  transactionHash: Hex
  data: Hex
  topics: [Hex, ...Hex[]]
  removed?: boolean
}

export function restoreWatch(raw: string | null): WatchState | undefined {
  if (!raw) return
  const value = JSON.parse(raw) as WatchState
  if (!value || !/^\d{1,20}$/.test(value.nextBlock) || !Array.isArray(value.rows) || value.rows.length > 30
    || !value.rows.every(row => row && isAddress(row.token) && typeof row.name === 'string'
      && typeof row.symbol === 'string' && /^\d{1,20}$/.test(row.block) && hashPattern.test(row.hash)
      && typeof row.ethPair === 'boolean' && Number.isInteger(row.taxBps))) {
    throw new Error('The saved scan position is invalid.')
  }
  return value
}

export async function launchHead(rpc: ReturnType<typeof rpcClient>) {
  if (quantity(await rpc('eth_chainId')) !== 46630n) throw new Error('Unexpected network. Tracking stopped.')
  const head = quantity(await rpc('eth_blockNumber'))
  if (head < 4n) throw new Error('The testnet head is unavailable.')
  return head
}

export async function scanLaunchBatch(nextBlock: string | undefined, rpc: ReturnType<typeof rpcClient>) {
  const safeHead = await launchHead(rpc) - 4n
  const from = nextBlock !== undefined ? BigInt(nextBlock) : safeHead > 249n ? safeHead - 249n : 0n
  if (from > safeHead) return { nextBlock: from.toString(), rows: [] }
  const to = from + 499n < safeHead ? from + 499n : safeHead
  const logs = await rpc('eth_getLogs', [{ address: factory, topics, fromBlock: toHex(from), toBlock: toHex(to) }])
  if (!Array.isArray(logs)) throw new Error('The testnet did not return a valid launch event batch.')
  const rows = new Map<string, LaunchRow>()
  const sorted = (logs as ChainLog[]).filter(log => !log.removed && log.address.toLowerCase() === factory.toLowerCase())
  sorted.sort((a, b) => Number(quantity(b.blockNumber) - quantity(a.blockNumber)) || Number(quantity(b.logIndex) - quantity(a.logIndex)))
  for (const log of sorted) {
    const block = quantity(log.blockNumber)
    if (block < from || block > to || !hashPattern.test(log.transactionHash)) throw new Error('The testnet returned an invalid launch event.')
    const { args } = decodeEventLog({ abi: [launchCreated], eventName: 'LaunchCreated', data: log.data, topics: log.topics })
    const key = args.token.toLowerCase()
    if (rows.has(key)) continue
    rows.set(key, {
      token: args.token, name: args.name, symbol: args.symbol, block: block.toString(), hash: log.transactionHash,
      ethPair: args.pairCurrency === zeroAddress, taxBps: args.taxBps,
    })
  }
  return { nextBlock: (to + 1n).toString(), rows: [...rows.values()] }
}

export async function scanLaunches(state?: WatchState, rpc = rpcClient()) {
  const batch = await scanLaunchBatch(state?.nextBlock, rpc)
  const recent = new Map(batch.rows.map(row => [row.token.toLowerCase(), row]))
  for (const row of state?.rows ?? []) {
    if (!recent.has(row.token.toLowerCase())) recent.set(row.token.toLowerCase(), row)
  }
  return { nextBlock: batch.nextBlock, rows: [...recent.values()].slice(0, 30) }
}
