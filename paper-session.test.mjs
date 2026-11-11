import assert from 'node:assert/strict'
import test from 'node:test'
import { addLaunches, evaluateSession, newPaperSession, paperTotals, restoreSession } from './paper-session.ts'
import { PaperRule } from './paper-trade.ts'

const token = n => `0x${n.toString(16).padStart(40, '0')}`
const launch = (id, ethPair = true) => ({ token: token(id), symbol: `T${id}`, block: '100', ethPair })
const signal = new AbortController().signal

function session(overrides = {}) {
  const values = {
    size: '0.001', cap: '0.002', age: '300', tax: '3', impact: '2', slippage: '1', tp: '20', sl: '10',
    budget: '0.00202', maxOpen: '2', exitShare: '100', ...overrides,
  }
  const form = new FormData()
  for (const [name, value] of Object.entries(values)) form.set(name, value)
  return newPaperSession(form, 100n)
}

function market(overrides = {}) {
  return {
    number: 105n, timestamp: BigInt(Math.floor(Date.now() / 1000)), age: 30n, tax: 100n,
    fee: 10000000000000n, sold: 100000000000000000000n,
    buy: async input => [input, input, input, 0n, 0n],
    sell: async () => [0n, 0n, 0n, 1300000000000000n], ...overrides,
  }
}

test('candidates are deduplicated, capped across simultaneous buys and kept after reload', async () => {
  const first = addLaunches(session(), { nextBlock: '101', rows: [launch(3), launch(2), launch(1), launch(1), launch(4, false)] })
  const queued = addLaunches(first, { nextBlock: '102', rows: [launch(1)] })
  assert.equal(queued.rows.length, 4)
  assert.equal(queued.rows.find(row => row.token === token(4)).state, 'skipped')
  const filled = await evaluateSession(queued, signal, async () => market())
  assert.deepEqual(paperTotals(filled), { spent: 2020000000000000n, pnl: 0n, open: 2 })
  assert.deepEqual(filled.rows.filter(row => row.state === 'open').map(row => row.token), [token(1), token(2)])
  assert.match(filled.rows.find(row => row.token === token(3)).reason, /budget exhausted/)
  const restored = restoreSession(JSON.stringify(filled))
  const closed = await evaluateSession(restored, signal, async () => market())
  assert.equal(closed.rows.filter(row => row.reason === 'Take profit').length, 2)
  assert.equal(paperTotals(closed).spent, paperTotals(filled).spent)
  assert.equal(paperTotals(closed).open, 0)
  assert.deepEqual(restoreSession(JSON.stringify(closed)), closed)
})

test('opening tax, scan outage, RPC failures and slot limits do not create extra entries', async () => {
  const queued = addLaunches(session({ maxOpen: '1' }), { nextBlock: '101', rows: [launch(2), launch(1)] })
  const paused = await evaluateSession(queued, signal, async () => assert.fail('entry during scan outage'), false)
  assert.deepEqual(paused, queued)
  const delayed = await evaluateSession(queued, signal, async address => {
    if (address === token(2)) throw new Error('RPC offline')
    return market({ tax: 9900n })
  })
  assert.match(delayed.rows[0].reason, /tax/)
  assert.match(delayed.rows[1].reason, /RPC offline/)
  const ready = await evaluateSession(delayed, signal, async () => market())
  assert.equal(paperTotals(ready).open, 1)
  assert.match(ready.rows.find(row => row.state === 'waiting').reason, /position slot/)
  const expired = await evaluateSession(ready, signal, async (_token, side) => {
    if (side === 'sell') throw new PaperRule('Curve closed.', true)
    return market({ age: 301n })
  })
  assert.equal(expired.rows.find(row => row.token === token(1)).state, 'blocked')
  assert.equal(expired.rows.find(row => row.token === token(2)).state, 'skipped')
})

test('partial stop loss keeps the remaining position and never repeats the exit', async () => {
  const queued = addLaunches(session({ exitShare: '50' }), { nextBlock: '101', rows: [launch(1)] })
  const filled = await evaluateSession(queued, signal, async () => market())
  const closed = await evaluateSession(filled, signal, async () => market({ sell: async () => [0n, 0n, 0n, 400000000000000n] }))
  const [row] = closed.rows
  assert.equal(row.state, 'partial')
  assert.equal(row.reason, 'Stop loss')
  assert.equal(BigInt(row.fill.exit.tokens) * 2n, BigInt(row.fill.tokens))
  assert.equal(paperTotals(closed).open, 1)
  assert.deepEqual(await evaluateSession(restoreSession(JSON.stringify(closed)), signal, async () => assert.fail('repeat exit')), closed)
})

test('aborting before a pending quote settles leaves the saved ledger unchanged', async () => {
  const queued = addLaunches(session(), { nextBlock: '101', rows: [launch(1)] })
  const stop = new AbortController()
  await assert.rejects(evaluateSession(queued, stop.signal, async () => {
    stop.abort()
    return market()
  }), { name: 'AbortError' })
  assert.equal(paperTotals(queued).spent, 0n)
})
