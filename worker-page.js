const display = id => document.getElementById(id)
const feed = {
  live: 'Live · WebSocket',
  connecting: 'Connecting · HTTP available',
  retrying: 'Reconnecting · HTTP fallback',
}

async function refresh() {
  try {
    const response = await fetch('/status', { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error()
    const snapshot = await response.json()
    display('feed').textContent = feed[snapshot.feed] ?? 'Unknown'
    display('block').textContent = snapshot.state ? (BigInt(snapshot.state.nextBlock) - 1n).toString() : '—'
    display('updated').textContent = snapshot.lastScanAt ? new Date(snapshot.lastScanAt).toLocaleString() : '—'
    display('status').textContent = snapshot.scanError ?? (snapshot.state ? 'Tracking launches.' : 'Waiting for the first scan.')
    display('launches').replaceChildren(...(snapshot.state?.rows ?? []).map(row => {
      const item = document.createElement('li')
      const link = document.createElement('a')
      link.href = `https://testnet.vibevibe.fun/token/${row.token}`
      link.textContent = `${row.name} ($${row.symbol})`
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      const detail = document.createElement('span')
      detail.textContent = `Block ${row.block} · ${row.ethPair ? 'ETH pair' : 'Other pair'} · ${row.taxBps / 100}% base tax`
      item.append(link, detail)
      if (row.ethPair) {
        const review = document.createElement('a')
        const target = new URL(`http://127.0.0.1:${snapshot.appPort}/`)
        target.searchParams.set('watchBuy', row.token)
        target.hash = 'test-buy-heading'
        review.href = target.href
        review.textContent = 'Review buy in LaunchPilot ↗'
        review.target = '_blank'
        review.rel = 'noopener noreferrer'
        item.append(review)
      }
      return item
    }))
  } catch {
    display('feed').textContent = 'Unavailable'
    display('status').textContent = 'Cannot reach the worker. The previous scan is shown if available.'
  }
  window.setTimeout(refresh, 5000)
}
void refresh()
