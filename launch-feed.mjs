const feedUrl = 'wss://feed.testnet.chain.robinhood.com'

export function feedSignal(data) {
  if (typeof data !== 'string' || data.length > 2 * 1024 * 1024) return false
  try {
    const message = JSON.parse(data)
    return message?.version === 1 && Array.isArray(message.messages)
      && Number.isSafeInteger(message.messages[0]?.sequenceNumber) && message.messages[0].sequenceNumber >= 0
  } catch {
    return false
  }
}

export function watchFeed(onSignal, onStatus, connect = () => new WebSocket(feedUrl)) {
  let socket
  let timer
  let stopped = false
  let failures = 0
  function retry() {
    onStatus('retrying')
    const wait = Math.min(60000, 2000 * 2 ** Math.min(failures++, 5))
    timer = setTimeout(open, wait)
  }
  function open() {
    if (stopped) return
    onStatus('connecting')
    let current
    try {
      current = connect()
    } catch {
      retry()
      return
    }
    socket = current
    function disconnect() {
      if (socket !== current) return
      clearTimeout(timer)
      socket = undefined
      current.close()
      retry()
    }
    function deadline(ms) {
      clearTimeout(timer)
      timer = setTimeout(disconnect, ms)
    }
    deadline(12000)
    current.addEventListener('close', disconnect)
    current.addEventListener('error', disconnect)
    current.addEventListener('message', event => {
      if (socket !== current || !feedSignal(event.data)) return
      failures = 0
      deadline(60000)
      onStatus('live')
      onSignal()
    })
  }
  open()
  return () => {
    stopped = true
    clearTimeout(timer)
    const current = socket
    socket = undefined
    current?.close()
  }
}
