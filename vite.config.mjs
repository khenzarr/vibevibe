import { defineConfig, loadEnv } from 'vite'

const maxBytes = 512 * 1024
const cidPattern = /^(?:b[a-z2-7]{58,120}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])

async function pin(jwt, file) {
  const form = new FormData()
  form.set('file', file)
  form.set('pinataOptions', JSON.stringify({ cidVersion: 1 }))
  const result = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form,
    signal: AbortSignal.timeout(15000),
  })
  if (!result.ok) throw new Error('The pinning service rejected the upload.')
  const payload = await result.json()
  if (typeof payload.IpfsHash !== 'string' || !cidPattern.test(payload.IpfsHash)) {
    throw new Error('The pinning service returned an invalid CID.')
  }
  return `ipfs://${payload.IpfsHash}`
}

function metadataEndpoint(jwt) {
  const handle = async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(body))
    }
    const host = request.headers.host ?? ''
    const localHost = /^(localhost|127\.0\.0\.1):[0-9]+$/.test(host)
    if (!localHost || request.method !== 'POST' || request.headers.origin !== `http://${host}`) {
      return send(403, { error: 'Icon pinning is available from this local app only.' })
    }
    if (!jwt) return send(503, { error: 'Local IPFS pinning is not configured. Use an existing public metadata URI.' })
    const contentType = request.headers['content-type']
    const length = Number(request.headers['content-length'])
    if (typeof contentType !== 'string' || !contentType.startsWith('multipart/form-data;')
      || !Number.isSafeInteger(length) || length <= 0 || length > maxBytes + 4096) {
      return send(400, { error: 'Upload a PNG, JPEG or WebP icon up to 512 KB.' })
    }
    try {
      const form = await new Response(await Array.fromAsync(request).then(Buffer.concat), {
        headers: { 'Content-Type': contentType },
      }).formData()
      const file = form.get('icon')
      const name = form.get('name')
      const symbol = form.get('symbol')
      const creator = form.get('creator')
      const description = form.get('description')
      const width = Number(form.get('width'))
      const height = Number(form.get('height'))
      if (!(file instanceof File) || !imageTypes.has(file.type) || file.size < 1 || file.size > maxBytes
        || typeof name !== 'string' || !name.trim() || Buffer.byteLength(name) > 64
        || typeof symbol !== 'string' || !/^[A-Z0-9]{1,12}$/.test(symbol)
        || typeof creator !== 'string' || !/^0x[0-9a-f]{40}$/i.test(creator)
        || typeof description !== 'string' || description.length > 500
        || ![width, height].every((n) => Number.isInteger(n) && n >= 1 && n <= 512)) {
        return send(400, { error: 'Check the token details and icon before pinning.' })
      }
      const signature = Buffer.from(await file.slice(0, 16).arrayBuffer())
      const valid = file.type === 'image/png' ? signature.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
        : file.type === 'image/jpeg' ? signature.subarray(0, 3).toString('hex') === 'ffd8ff'
        : signature.subarray(0, 4).toString() === 'RIFF' && signature.subarray(8, 12).toString() === 'WEBP'
      if (!valid) return send(400, { error: 'The file does not match its declared image type.' })
      const iconUri = await pin(jwt, file)
      const metadata = {
        schemaVersion: 1, chainId: 46630, creator, name, symbol, description, socials: {},
        image: { uri: iconUri, mimeType: file.type, bytes: file.size, width, height },
      }
      const uri = await pin(jwt, new File([JSON.stringify(metadata)], 'metadata.json', { type: 'application/json' }))
      send(201, { uri })
    } catch {
      send(502, { error: 'IPFS pinning did not complete. Try again or use an existing metadata URI.' })
    }
  }
  const install = (server) => { server.middlewares.use('/api/metadata', handle) }
  return { name: 'launchpilot-local-metadata', configureServer: install, configurePreviewServer: install }
}

export default defineConfig(({ mode }) => ({
  plugins: [metadataEndpoint(process.env.PINATA_JWT || loadEnv(mode, process.cwd(), '').PINATA_JWT)],
}))
