import { decodeFunctionResult, encodeFunctionData, isAddress, parseAbi, toHex, zeroAddress, type Abi, type Address, type Hex } from 'viem'
import { amount, factory, quantity, rpcClient } from './protocol.ts'

const abi = parseAbi([
  'function curveOf(address token) view returns (address)',
  'function pairCurrency() view returns (address)',
  'function createdAt() view returns (uint256)',
  'function complete() view returns (bool)',
  'function sold() view returns (uint120)',
  'function currentRateBps() view returns (uint256)',
  'function quoteBuyExactIn(uint256 pairIn) view returns (uint256 gross, uint256 net, uint256 cost, uint256 pairFee, uint256 refund)',
  'function quoteSell(uint256 grossTokens) view returns (uint256 net, uint256 proceeds, uint256 pairFee, uint256 pairOut)',
])
const scale = 10000n
const inventory = 800000000n * 10n ** 18n
export const paperGas = { buy: 1000000n, sell: 1100000n }
type Side = keyof typeof paperGas
type Rpc = ReturnType<typeof rpcClient>

export function paperLimits(field: (name: string) => string) {
  const percent = (name: string) => amount(field(name), name, 2)
  const size = amount(field('size'), 'Buy size')
  const cap = amount(field('cap'), 'Spend cap')
  const age = amount(field('age'), 'Max age', 0)
  const tax = percent('tax')
  const impact = percent('impact')
  const slippage = percent('slippage')
  const tp = percent('tp')
  const sl = percent('sl')
  if (size <= 0n || cap <= 0n || age <= 0n || tp <= 0n || sl <= 0n
    || sl > scale || tax > scale || impact > scale || slippage >= scale) throw new Error('Check the amount, age and percentage limits.')
  return { size, cap, age, tax, impact, slippage, tp, sl }
}

export function paperSettings(form: FormData) {
  const token = String(form.get('token') ?? '').trim()
  if (!isAddress(token, { strict: false }) || token.toLowerCase() === zeroAddress) throw new Error('Enter a valid token address.')
  return { token: token as Address, ...paperLimits(name => String(form.get(name) ?? '')) }
}

export type PaperSettings = ReturnType<typeof paperSettings>
export class PaperRule extends Error {
  readonly terminal: boolean
  constructor(message: string, terminal = false) {
    super(message)
    this.terminal = terminal
  }
}

export async function paperMarket(token: Address, side: Side, rpc: Rpc, now = Date.now()) {
  if (quantity(await rpc('eth_chainId')) !== 46630n) throw new Error('Wrong network for paper trading.')
  const [header, gas] = await Promise.all([rpc('eth_getBlockByNumber', ['latest', false]), rpc('eth_gasPrice')])
  const block = header as { number?: Hex; timestamp?: Hex } | null
  const number = quantity(block?.number)
  const timestamp = quantity(block?.timestamp)
  const clock = BigInt(Math.floor(now / 1000))
  if (timestamp < clock - 45n || timestamp > clock + 10n) throw new Error('Testnet block timestamp is stale or invalid.')
  const gasPrice = quantity(gas)
  if (gasPrice === 0n) throw new Error('A current gas price is unavailable.')
  const fee = gasPrice * paperGas[side]
  async function read(to: Address, name: typeof abi[number]['name'], args: readonly unknown[] = []) {
    const contract: Abi = abi
    const data = encodeFunctionData({ abi: contract, functionName: name, args })
    const response = await rpc('eth_call', [{ to, data }, toHex(number)])
    return decodeFunctionResult({ abi: contract, functionName: name, data: response as Hex })
  }
  const curve = await read(factory, 'curveOf', [token]) as Address
  if (curve === zeroAddress) throw new PaperRule('This token does not belong to the supported V6 factory.', true)
  const [pair, complete, created, sold, tax] = await Promise.all([
    read(curve, 'pairCurrency') as Promise<Address>, read(curve, 'complete') as Promise<boolean>,
    read(curve, 'createdAt') as Promise<bigint>, read(curve, 'sold') as Promise<bigint>,
    read(curve, 'currentRateBps') as Promise<bigint>,
  ])
  if (pair !== zeroAddress) throw new PaperRule('Only native ETH pairs are supported.', true)
  if (complete || sold >= inventory) throw new PaperRule('Curve closed. Pool trading is outside this paper session.', true)
  if (created <= 0n || created > timestamp || tax > scale) throw new Error('The testnet returned invalid curve data.')
  return {
    number, timestamp, curve, gasPrice, fee, age: timestamp - created, tax, sold,
    buy: (input: bigint) => read(curve, 'quoteBuyExactIn', [input]) as Promise<readonly [bigint, bigint, bigint, bigint, bigint]>,
    sell: (tokens: bigint) => read(curve, 'quoteSell', [tokens]) as Promise<readonly [bigint, bigint, bigint, bigint]>,
  }
}

export type PaperMarket = Awaited<ReturnType<typeof paperMarket>>
export const minimumOut = (output: bigint, slippage: bigint) => output * (scale - slippage) / scale
export function requireFreshQuote(timestamp: bigint) {
  if (timestamp < BigInt(Math.floor(Date.now() / 1000)) - 45n) throw new Error('The quote expired while it was being read.')
}

export async function paperEntry(settings: Pick<PaperSettings, 'size' | 'cap' | 'age' | 'tax' | 'impact' | 'slippage'>, market: PaperMarket) {
  const cost = settings.size + market.fee
  if (market.age > settings.age) throw new PaperRule('Token is older than the entry window.', true)
  if (market.tax > settings.tax) throw new PaperRule('Effective buy tax exceeds your limit.')
  if (cost > settings.cap) throw new PaperRule('Buy plus the gas reserve exceeds your cap.')
  const probe = settings.size / 1000n
  if (!probe) throw new Error('Buy amount is too small for a price impact check.')
  const [[gross, out, principal, pairFee, refund], [, probeOut]] = await Promise.all([market.buy(settings.size), market.buy(probe)])
  if (refund > 0n || market.sold + gross >= inventory) throw new PaperRule('This buy would reach graduation. Use a smaller amount.')
  // Integer rounding can leave dust even when the curve reports no refund.
  if (out <= 0n || probeOut <= 0n || principal <= 0n || principal + pairFee > settings.size) throw new Error('A complete buy quote is unavailable.')
  const expected = probeOut * settings.size
  const actual = out * probe
  const impact = actual >= expected ? 0n : ((expected - actual) * scale + expected - 1n) / expected
  if (impact > settings.impact) throw new PaperRule('Price impact exceeds your limit.')
  const tokens = minimumOut(out, settings.slippage)
  if (tokens <= 0n) throw new Error('Minimum tokens after slippage are zero.')
  return { tokens, out, cost, impact, tax: market.tax, block: market.number }
}

export type PaperPosition = Awaited<ReturnType<typeof paperEntry>>

export function paperExit(position: Pick<PaperPosition, 'cost'>, pairOut: bigint, fee: bigint, settings: Pick<PaperSettings, 'slippage' | 'tp' | 'sl'>) {
  if (pairOut <= 0n) throw new Error('A positive sale quote is unavailable.')
  const proceeds = minimumOut(pairOut, settings.slippage) - fee
  const profit = proceeds - position.cost
  const change = profit * scale
  const trigger = change >= position.cost * settings.tp ? 'Take profit'
    : change <= -position.cost * settings.sl ? 'Stop loss' : null
  return { proceeds, profit, trigger }
}
