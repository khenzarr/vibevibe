import { readFile, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { restoreWatch, scanLaunches } from './launch-watch.ts'

export async function readCheckpoint(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  const state = restoreWatch(raw)
  if (!state || state.rows.some(row => BigInt(row.block) >= BigInt(state.nextBlock))) {
    throw new Error('The local launch checkpoint is invalid.')
  }
  return state
}

export async function saveCheckpoint(path, state) {
  const temporary = (path instanceof URL ? fileURLToPath(path) : path) + '.tmp'
  await writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600, flush: true })
  await rename(temporary, path)
}

export function workerScanner({ initial, rpc, persist, scan = scanLaunches }) {
  let state = initial
  let lastScanAt = null
  let scanError = null
  let failures = 0
  let nextScanAt = 0
  let active
  let timer
  let stopped = false

  function wake() {
    if (stopped || active || timer) return
    timer = setTimeout(() => {
      timer = undefined
      active = scanOnce().finally(() => { active = undefined })
    }, Math.max(0, nextScanAt - Date.now()))
  }

  async function scanOnce() {
    let next
    try {
      next = await scan(state, rpc)
    } catch {
      scanError = 'Testnet read failed. Retrying from the last saved block.'
    }
    if (next && !stopped) {
      try {
        if (next.nextBlock !== state?.nextBlock) await persist(next)
        state = next
        lastScanAt = new Date().toISOString()
        scanError = null
      } catch {
        scanError = 'Checkpoint could not be saved. The scan position has not advanced.'
      }
    }
    failures = scanError ? failures + 1 : 0
    nextScanAt = Date.now() + Math.min(60000, 4000 * 2 ** Math.min(failures, 4))
  }

  return {
    wake,
    snapshot: () => ({ state, lastScanAt, scanError }),
    async stop() {
      stopped = true
      clearTimeout(timer)
      await active
    },
  }
}
