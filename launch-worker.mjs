import { once } from 'node:events'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { watchFeed } from './launch-feed.mjs'
import { rpcClient } from './protocol.ts'
import { readCheckpoint, saveCheckpoint, workerScanner } from './worker-watch.mjs'

const host = '127.0.0.1'
const port = 4181
const appPort = Number(process.env.LAUNCHPILOT_APP_PORT ?? 4178)
if (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535 || appPort === port) {
  throw new Error('LAUNCHPILOT_APP_PORT must be a valid local port other than 4181.')
}
const localOrigin = `http://${host}:${port}`
const stateDirectory = new URL('./.worker-state/', import.meta.url)
const checkpoint = new URL('launch-watch.json', stateDirectory)
const [page, script] = await Promise.all([
  readFile(new URL('./worker-page.html', import.meta.url)),
  readFile(new URL('./worker-page.js', import.meta.url)),
])
const controller = new AbortController()
const startedAt = new Date().toISOString()
let feed = 'connecting'
let lastFeedAt = null
let scanner

const server = createServer((request, response) => {
  function send(code, type, body) {
    response.writeHead(code, {
      'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    })
    response.end(body)
  }
  if (request.headers.host !== `${host}:${port}`
    || (request.headers.origin && request.headers.origin !== localOrigin)) {
    return send(403, 'text/plain; charset=utf-8', 'Local access only.')
  }
  if (request.method !== 'GET') return send(405, 'text/plain; charset=utf-8', 'Read-only.')
  if (request.url === '/') return send(200, 'text/html; charset=utf-8', page)
  if (request.url === '/worker-page.js') return send(200, 'text/javascript; charset=utf-8', script)
  if (request.url === '/status') {
    return send(scanner ? 200 : 503, 'application/json; charset=utf-8',
      JSON.stringify({ startedAt, feed, lastFeedAt, appPort, ...scanner?.snapshot() }))
  }
  return send(404, 'text/plain; charset=utf-8', 'Not found.')
})

try {
  server.listen(port, host)
  await once(server, 'listening')
  await mkdir(stateDirectory, { recursive: true })
  scanner = workerScanner({
    initial: await readCheckpoint(checkpoint),
    rpc: rpcClient(controller.signal),
    persist: state => saveCheckpoint(checkpoint, state),
  })
} catch (error) {
  console.error(error.code === 'EADDRINUSE' ? 'Port 4181 is already in use. Check the existing worker.' : `Unable to start launch watch. ${error.message}`)
  server.close()
  process.exitCode = 1
}

if (scanner) {
  const stopFeed = watchFeed(() => {
    lastFeedAt = new Date().toISOString()
    scanner.wake()
  }, status => { feed = status })
  const fallback = setInterval(scanner.wake, 12000)
  scanner.wake()
  console.log(`LaunchPilot read-only worker: ${localOrigin}/`)
  const saved = scanner.snapshot().state
  console.log(saved ? `Resuming at block ${saved.nextBlock}.` : 'Starting with the recent block window.')
  async function stop() {
    clearInterval(fallback)
    stopFeed()
    controller.abort()
    server.close()
    await scanner.stop()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
