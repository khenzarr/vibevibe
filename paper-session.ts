import { isAddress, type Address } from 'viem'
import type { LaunchRow } from './launch-watch.ts'
import { paperEntry, paperExit, paperLimits, paperMarket, PaperRule, requireFreshQuote } from './paper-trade.ts'
import { amount, factory, rpcClient } from './protocol.ts'

export const sessionKey = `launchpilot.paper.46630.${factory.toLowerCase()}.v1`
const ledgerLimit = 500
const configFields = ['size', 'cap', 'age', 'tax', 'impact', 'slippage', 'tp', 'sl', 'budget', 'maxOpen', 'exitShare'] as const
type Config = Record<typeof configFields[number], string>
const states = ['waiting', 'skipped', 'open', 'closed', 'partial', 'blocked'] as const
type State = typeof states[number]
interface Fill {
  cost: string
  tokens: string
  block: string
  exit?: { tokens: string; profit: string; block: string }
}
interface Candidate {
  token: Address
  symbol: string
  block: string
  state: State
  reason: string
  fill?: Fill
}
export interface PaperSession {
  config: Config
  nextBlock: string
  full: boolean
  rows: Candidate[]
}

const unsigned = (value: unknown) => typeof value === 'string' && /^\d{1,80}$/.test(value)
const decimal = (value: unknown) => typeof value === 'string' && /^-?\d{1,80}$/.test(value)
const occupied = (row: Candidate) => row.fill && row.state !== 'closed'
const reason = (error: unknown) => (error instanceof Error ? error.message : 'Live quote unavailable.').slice(0, 240)

export function sessionLimits(config: Config) {
  const limits = paperLimits(name => config[name as keyof Config])
  const budget = amount(config.budget, 'Session budget')
  const maxOpen = Number(amount(config.maxOpen, 'Max open positions', 0))
  const exitShare = amount(config.exitShare, 'Exit share', 2)
  if (budget < limits.size || maxOpen < 1 || maxOpen > 5 || exitShare <= 0n || exitShare > 10000n) {
    throw new Error('Use a session budget that covers the buy size, 1–5 open positions and an exit share above 0% up to 100%.')
  }
  return { ...limits, budget, maxOpen, exitShare }
}

export function newPaperSession(form: FormData, nextBlock: bigint): PaperSession {
  const config = Object.fromEntries(configFields.map(name => [name, String(form.get(name) ?? '').trim()])) as Config
  sessionLimits(config)
  return { config, nextBlock: nextBlock.toString(), full: false, rows: [] }
}

export function paperTotals(session: PaperSession) {
  const spent = session.rows.reduce((total, row) => total + BigInt(row.fill?.cost ?? 0), 0n)
  const pnl = session.rows.reduce((total, row) => total + BigInt(row.fill?.exit?.profit ?? 0), 0n)
  return { spent, pnl, open: session.rows.filter(occupied).length }
}

export function restoreSession(raw: string | null): PaperSession | undefined {
  if (raw === null) return
  const saved = JSON.parse(raw) as PaperSession
  if (!saved?.config || !configFields.every(key => typeof saved.config[key] === 'string' && saved.config[key].length <= 40)
    || !unsigned(saved.nextBlock) || typeof saved.full !== 'boolean' || !Array.isArray(saved.rows) || saved.rows.length > ledgerLimit) {
    throw new Error('The saved paper session is invalid.')
  }
  const seen = new Set<string>()
  for (const row of saved.rows) {
    if (!row || !isAddress(row.token, { strict: false }) || seen.has(row.token.toLowerCase()) || !unsigned(row.block)
      || BigInt(row.block) >= BigInt(saved.nextBlock) || !states.includes(row.state)
      || typeof row.symbol !== 'string' || typeof row.reason !== 'string') throw new Error('Invalid saved candidate.')
    seen.add(row.token.toLowerCase())
    const filled = row.state !== 'waiting' && row.state !== 'skipped'
    if (!filled && row.fill === undefined) continue
    const fill = row.fill
    if (!filled || !fill || !unsigned(fill.cost) || !unsigned(fill.tokens) || !unsigned(fill.block)
      || BigInt(fill.cost) === 0n || BigInt(fill.tokens) === 0n || BigInt(fill.block) < BigInt(row.block)) throw new Error('Invalid saved paper fill.')
    const exited = row.state === 'closed' || row.state === 'partial'
    if (!exited && fill.exit === undefined) continue
    const exit = fill.exit
    if (!exited || !exit || !unsigned(exit.tokens) || !decimal(exit.profit) || !unsigned(exit.block)
      || BigInt(exit.tokens) === 0n || BigInt(exit.block) < BigInt(fill.block)
      || (row.state === 'closed' ? exit.tokens !== fill.tokens : BigInt(exit.tokens) >= BigInt(fill.tokens))) throw new Error('Invalid saved paper exit.')
  }
  const limits = sessionLimits(saved.config)
  const { spent, open } = paperTotals(saved)
  if (spent > limits.budget || open > limits.maxOpen || saved.rows.some(row => row.fill && BigInt(row.fill.cost) > limits.cap)) {
    throw new Error('The saved paper ledger exceeds its limits.')
  }
  return saved
}

export function addLaunches(session: PaperSession, batch: { nextBlock: string; rows: LaunchRow[] }): PaperSession {
  if (session.full) return session
  const seen = new Set(session.rows.map(row => row.token.toLowerCase()))
  const additions: Candidate[] = []
  // The watch reader returns newest first. Evaluate the oldest new event first.
  for (const launch of [...batch.rows].reverse()) {
    const key = launch.token.toLowerCase()
    if (seen.has(key) || BigInt(launch.block) < BigInt(session.nextBlock)) continue
    seen.add(key)
    additions.push({
      token: launch.token as Address, symbol: launch.symbol, block: launch.block,
      state: launch.ethPair ? 'waiting' : 'skipped',
      reason: launch.ethPair ? 'Waiting for a live quote.' : 'Pair outside scope.',
    })
  }
  const rows = [...session.rows, ...additions]
  if (rows.length > ledgerLimit) return { ...session, full: true }
  return { ...session, nextBlock: batch.nextBlock, rows, full: rows.length === ledgerLimit }
}

export async function evaluateSession(
  session: PaperSession, signal: AbortSignal, readMarket: typeof paperMarket = paperMarket, allowEntries = true,
): Promise<PaperSession> {
  const settings = sessionLimits(session.config)
  const rpc = rpcClient(signal)
  let { spent, open } = paperTotals(session)
  const candidates = allowEntries ? session.rows.filter(row => row.state === 'waiting').slice(0, 4) : []
  const checked = new Set(candidates)
  const rows: Candidate[] = []
  for (const row of session.rows) {
    signal.throwIfAborted()
    if (checked.has(row)) continue
    const fill = row.fill
    if (row.state !== 'open' || !fill) {
      rows.push(row)
      continue
    }
    try {
      const market = await readMarket(row.token, 'sell', rpc)
      if (market.number < BigInt(fill.block)) throw new Error('Waiting for a block at or after entry.')
      const held = BigInt(fill.tokens)
      const tokens = held * settings.exitShare / 10000n
      if (tokens === 0n) throw new PaperRule('The selected exit share rounds to zero tokens.', true)
      const [, , , pairOut] = await market.sell(tokens)
      requireFreshQuote(market.timestamp)
      const cost = (BigInt(fill.cost) * tokens + held - 1n) / held
      const exit = paperExit({ cost }, pairOut, market.fee, settings)
      if (!exit.trigger) {
        rows.push({ ...row, reason: `Watching TP/SL · block ${market.number}.` })
        continue
      }
      const closed = tokens === held
      if (closed) open--
      rows.push({
        ...row, state: closed ? 'closed' : 'partial', reason: exit.trigger,
        fill: { ...fill, exit: { tokens: tokens.toString(), profit: exit.profit.toString(), block: market.number.toString() } },
      })
    } catch (error) {
      rows.push({ ...row, state: error instanceof PaperRule && error.terminal ? 'blocked' : 'open', reason: reason(error) })
    }
  }
  for (const row of candidates) {
    signal.throwIfAborted()
    try {
      if (spent + settings.size >= settings.budget) throw new PaperRule('Session buy budget exhausted.', true)
      const market = await readMarket(row.token, 'buy', rpc)
      if (market.number < BigInt(row.block)) throw new Error('Waiting for the launch block.')
      if (market.age > settings.age) throw new PaperRule('Token is older than the entry window.', true)
      if (open >= settings.maxOpen) throw new PaperRule('Waiting for an open position slot.')
      const entry = await paperEntry(settings, market)
      requireFreshQuote(market.timestamp)
      if (spent + entry.cost > settings.budget) throw new PaperRule('Buy plus gas exceeds the remaining session budget.')
      spent += entry.cost
      open++
      rows.push({
        ...row, state: 'open', reason: 'Virtual buy at the minimum quoted output.',
        fill: { tokens: entry.tokens.toString(), cost: entry.cost.toString(), block: entry.block.toString() },
      })
    } catch (error) {
      rows.push({ ...row, state: error instanceof PaperRule && error.terminal ? 'skipped' : 'waiting', reason: reason(error) })
    }
  }
  signal.throwIfAborted()
  return { ...session, rows }
}
