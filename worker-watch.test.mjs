import assert from 'node:assert/strict'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { feedSignal, watchFeed } from './launch-feed.mjs'
import { readCheckpoint, saveCheckpoint, workerScanner } from './worker-watch.mjs'

test('checkpoint is replaced and a corrupt checkpoint is rejected', async t => {
  const folder = await mkdtemp(fileURLToPath(new URL('./.watch-test-', import.meta.url)))
  const path = join(folder, 'watch.json')
  t.after(async () => {
    await Promise.allSettled([unlink(path), unlink(path + '.tmp')])
    await rmdir(folder)
  })
  assert.equal(await readCheckpoint(path), undefined)
  await saveCheckpoint(path, { nextBlock: '100', rows: [] })
  await saveCheckpoint(path, { nextBlock: '200', rows: [] })
  assert.deepEqual(await readCheckpoint(path), { nextBlock: '200', rows: [] })
  await writeFile(path, '{}')
  await assert.rejects(readCheckpoint(path), /invalid/)
})

test('overlapping wakes coalesce and HTTP or disk failure cannot move the cursor', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 })
  const starts = []
  const persisted = []
  const scanner = workerScanner({
    initial: { nextBlock: '100', rows: [] },
    async scan(state) {
      starts.push(state.nextBlock)
      if (starts.length === 1) throw new Error('HTTP offline')
      return { nextBlock: '101', rows: [] }
    },
    async persist(next) {
      if (starts.length === 2) throw new Error('disk unavailable')
      persisted.push(next.nextBlock)
    },
  })
  t.after(() => scanner.stop())
  scanner.wake()
  scanner.wake()
  t.mock.timers.tick(1)
  await setImmediate()
  assert.match(scanner.snapshot().scanError, /Testnet/)
  assert.equal(scanner.snapshot().state.nextBlock, '100')
  scanner.wake()
  t.mock.timers.tick(8000)
  await setImmediate()
  assert.match(scanner.snapshot().scanError, /Checkpoint/)
  assert.equal(scanner.snapshot().state.nextBlock, '100')
  scanner.wake()
  t.mock.timers.tick(16000)
  await setImmediate()
  assert.equal(scanner.snapshot().scanError, null)
  assert.deepEqual(starts, ['100', '100', '100'])
  assert.deepEqual(persisted, ['101'])
  assert.equal(scanner.snapshot().state.nextBlock, '101')
})

test('public sequencer frames wake scans and a disconnected feed reconnects', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const valid = JSON.stringify({ version: 1, messages: [{ sequenceNumber: 150000000 }] })
  assert.equal(feedSignal('bad frame'), false)
  assert.equal(feedSignal('{"version":1,"messages":[]}'), false)
  assert.equal(feedSignal(valid), true)
  const states = []
  const sockets = []
  let signals = 0
  const stop = watchFeed(() => signals++, state => states.push(state), () => {
    const socket = new EventTarget()
    socket.close = () => socket.dispatchEvent(new Event('close'))
    sockets.push(socket)
    return socket
  })
  t.after(stop)
  sockets[0].dispatchEvent(new MessageEvent('message', { data: valid }))
  sockets[0].dispatchEvent(new Event('close'))
  t.mock.timers.tick(2000)
  sockets[0].dispatchEvent(new MessageEvent('message', { data: valid }))
  sockets[1].dispatchEvent(new MessageEvent('message', { data: valid }))
  assert.deepEqual(states, ['connecting', 'live', 'retrying', 'connecting', 'live'])
  assert.equal(signals, 2)
})
