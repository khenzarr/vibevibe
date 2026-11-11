import assert from 'node:assert/strict'
import test from 'node:test'
import { paperEntry, paperExit, paperMarket } from './paper-trade.ts'

const settings = { size: 10000n, cap: 10100n, age: 60n, tax: 300n, impact: 100n, slippage: 100n, tp: 2000n, sl: 1000n }
const market = {
  number: 1n, fee: 100n, age: 30n, tax: 100n, sold: 10000n,
  buy: async input => input === 10n ? [20n, 20n, 9n, 0n, 0n] : [19900n, 19900n, 9900n, 99n, 0n],
}

test('paper entry applies the age, tax, inclusive spend cap, impact and slippage rules', async () => {
  const entry = await paperEntry(settings, market)
  assert.equal(entry.cost, settings.cap)
  assert.equal(entry.impact, 50n)
  assert.equal(entry.tokens, 19701n)
  await assert.rejects(paperEntry({ ...settings, age: 29n }, market), /older/)
  await assert.rejects(paperEntry({ ...settings, tax: 99n }, market), /tax/)
  await assert.rejects(paperEntry({ ...settings, cap: 10099n }, market), /cap/)
  await assert.rejects(paperEntry({ ...settings, impact: 49n }, market), /impact/)
  await assert.rejects(paperEntry(settings, { ...market, buy: async () => { throw Error('RPC unavailable') } }), /RPC unavailable/)
})

test('paper exit thresholds use slippage and gas on both sides of the decision', () => {
  const position = { cost: 10000n }
  const tp = paperExit(position, 12223n, 100n, settings)
  assert.equal(tp.profit, 2000n)
  assert.equal(tp.trigger, 'Take profit')
  assert.equal(paperExit(position, 12222n, 100n, settings).trigger, null)
  assert.equal(paperExit(position, 9192n, 100n, settings).trigger, 'Stop loss')
  assert.equal(paperExit(position, 9193n, 100n, settings).trigger, null)
  assert.throws(() => paperExit(position, 0n, 100n, settings), /sale quote/)
})

test('a stale block cannot reach contract reads', async () => {
  const rpc = async method => {
    if (method === 'eth_chainId') return '0xb626'
    if (method === 'eth_getBlockByNumber') return { number: '0x1', timestamp: '0x1' }
    if (method === 'eth_gasPrice') return '0x1'
    assert.fail(method)
  }
  await assert.rejects(paperMarket('0x0000000000000000000000000000000000000001', 'buy', rpc, 60000), /stale/)
})
