export const ipfsUri = /^ipfs:\/\/(?:b[a-z2-7]{58,120}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/
const gateway = 'https://gateway.pinata.cloud/ipfs/'

export function ipfsHttp(uri: string) {
  if (!ipfsUri.test(uri)) throw new Error('Use a public IPFS CID.')
  return gateway + uri.slice(7)
}

export interface MetadataIdentity {
  name: string
  symbol: string
  sender: string
}

export function verifyMetadataDocument(document: unknown, identity: MetadataIdentity) {
  if (!document || typeof document !== 'object') throw new Error('The IPFS address must point to token metadata.')
  const value = document as {
    chainId?: number; schemaVersion?: number; name?: string; symbol?: string; creator?: string
    image?: { uri?: string; mimeType?: string; bytes?: number; width?: number; height?: number }
  }
  if (value.chainId !== 46630 || value.schemaVersion !== 1
    || value.name !== identity.name || value.symbol !== identity.symbol
    || typeof value.creator !== 'string' || value.creator.toLowerCase() !== identity.sender.toLowerCase()) {
    throw new Error('The IPFS metadata must match your draft name, ticker, creator and Robinhood Testnet.')
  }
  const image = value.image
  if (!image?.uri || !ipfsUri.test(image.uri) || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType ?? '')
    || ![image.bytes, image.width, image.height].every((field) => Number.isSafeInteger(field) && Number(field) > 0)) {
    throw new Error('The V6 metadata needs a public IPFS icon and valid image details.')
  }
  return image.uri
}

async function readSmallMetadata(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('The metadata gateway returned an empty response.')
  const decoder = new TextDecoder()
  let length = 0
  let result = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return JSON.parse(result + decoder.decode()) as unknown
      length += value.byteLength
      if (length > 16_384) throw new Error('The metadata document is too large.')
      result += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export async function checkPublicMetadata(uri: string, identity: MetadataIdentity) {
  const response = await fetch(ipfsHttp(uri), { signal: AbortSignal.timeout(12000), redirect: 'error' })
  if (!response.ok) throw new Error('The public metadata is not available at the IPFS gateway yet.')
  const iconUri = verifyMetadataDocument(await readSmallMetadata(response), identity)
  const image = await fetch(ipfsHttp(iconUri), {
    method: 'HEAD', signal: AbortSignal.timeout(12000), redirect: 'error',
  })
  if (!image.ok || !/^image\/(png|jpeg|webp)(?:;|$)/i.test(image.headers.get('content-type') ?? '')) {
    throw new Error('The icon referenced by the metadata is not available as PNG, JPEG or WebP.')
  }
}
