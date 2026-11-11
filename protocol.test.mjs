import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeAbiParameters, encodeEventTopics, zeroAddress, zeroHash } from 'viem'
import { amount, budget, factory, launchCreated, openingFunding, readLaunchReceipt, rehearse, refusalMessage, reviewForWallet, RpcError } from './protocol.ts'
import { restoreWatch, scanLaunches } from './launch-watch.ts'
import { verifyMetadataDocument } from './metadata.ts'
import { onTestnet, switchToTestnet, walletAccount } from './wallet.ts'

test('launch watch retries the same range after an RPC failure and keeps one row per token', async () => {
  const state = { nextBlock: '256', rows: [] }
  const token = '0x0000000000000000000000000000000000000001'
  const log = {
    address: factory,
    blockNumber: '0x101',
    logIndex: '0x0',
    transactionHash: zeroHash,
    topics: encodeEventTopics({ abi: [launchCreated], eventName: 'LaunchCreated', args: { launchId: 1n, launcher: zeroAddress, token } }),
    data: encodeAbiParameters(launchCreated.inputs.filter(input => !input.indexed),
      [zeroAddress, 'Test token', 'TEST', 'ipfs://test', zeroAddress, 100, 0n, zeroAddress, 1n, 0n, 0n, zeroHash, 0n]),
  }
  let requests = 0
  const rpc = async (method, params) => {
    if (method === 'eth_chainId') return '0xb626'
    if (method === 'eth_blockNumber') return '0x106'
    assert.equal(method, 'eth_getLogs')
    assert.equal(params[0].fromBlock, '0x100')
    assert.equal(params[0].toBlock, '0x102')
    if (++requests === 1) throw new Error('RPC unavailable')
    return [log, log]
  }
  await assert.rejects(scanLaunches(state, rpc), /RPC unavailable/)
  assert.deepEqual(state, { nextBlock: '256', rows: [] })
  const result = restoreWatch(JSON.stringify(await scanLaunches(state, rpc)))
  assert.equal(result.nextBlock, '259')
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].token, token)
  assert.equal(result.rows[0].ethPair, true)
})

test('opening funding matches a published V6 ETH launch', () => {
  // Transaction 0x7fb36c3b4572f7e831114fd0c7025e0921a7724ef87b32d67e9560ca3625a18e.
  const net = amount('10000000', 'opening')
  const weights = [2000n, 7500n, 500n, 0n]
  assert.equal(openingFunding(net, amount('4', 'target'), 100, weights), 12746069242297239n)
  assert.throws(() => openingFunding(amount('501000000', 'opening'), amount('4', 'target'), 100, weights), /50%/)
})

test('checks the cap to one wei without adding the creation fee twice', () => {
  const total = 13217932852297239n
  for (const [cap, pass] of [[total - 1n, false], [total, true], [total + 1n, true]]) {
    const review = budget(400000000000000n, 12746069242297239n, 7186361n, 10000000n, cap)
    assert.equal(review.total, total)
    assert.equal(review.withinCap, pass)
  }
  assert.throws(() => budget(1n, 0n, 0n, 1n, 10n), /complete network cost/)
})

test('refuses a different chain before simulating', async () => {
  await assert.rejects(rehearse({}, async () => '0x1'), /Wrong network/)
})

test('refuses unrecognized deployment links before simulating', async () => {
  const replies = [
    '0xb626', { number: '0x100', timestamp: '0x200' },
    encodeAbiParameters([{ type: 'address' }], ['0x0000000000000000000000000000000000000001']),
    encodeAbiParameters([{ type: 'address' }], ['0x0000000000000000000000000000000000000001']),
    encodeAbiParameters([{ type: 'bool' }], [true]),
    encodeAbiParameters([{ type: 'uint256' }], [1n]),
    encodeAbiParameters([{ type: 'uint256' }], [1n]),
  ]
  await assert.rejects(rehearse({}, async () => replies.shift()), /deployment could not be verified/)
})

test('surfaces network failures and explains known testnet refusals', async () => {
  const unavailable = new RpcError('The Robinhood testnet did not respond.')
  await assert.rejects(rehearse({}, async () => { throw unavailable }), { message: unavailable.message })
  assert.match(refusalMessage(new RpcError('execution reverted', '0x11011294', true)), /attached ETH/)
})

test('requires another review for a higher fee, changed value or insufficient balance', () => {
  const review = { transaction: { value: '0x10' }, maxTotal: 25n, cap: 30n, target: 4n }
  assert.equal(reviewForWallet(review, review, 25n), review.transaction)
  assert.throws(() => reviewForWallet(review, { ...review, maxTotal: 31n }, 100n), /exceeds your cap/)
  assert.throws(() => reviewForWallet(review, { ...review, maxTotal: 26n }, 100n), /changed/)
  assert.throws(() => reviewForWallet(review, { ...review, transaction: { value: '0x11' } }, 100n), /changed/)
  assert.throws(() => reviewForWallet(review, review, 24n), /cannot cover/)
})

test('wallet connection and network switch use wallet methods without requesting a transaction', async () => {
  const account = '0x0000000000000000000000000000000000000010'
  let network = '0x1'
  let added = false
  const methods = []
  const wallet = { async request({ method, params }) {
    methods.push(method)
    if (method === 'eth_requestAccounts') return [account]
    if (method === 'eth_chainId') return network
    if (method === 'wallet_addEthereumChain') { added = true; return null }
    if (method === 'wallet_switchEthereumChain') {
      if (!added) throw { code: 4902 }
      network = params[0].chainId
      return null
    }
    throw new Error(method)
  } }
  assert.equal(await walletAccount(wallet, true), account)
  assert.equal(await onTestnet(wallet), false)
  await switchToTestnet(wallet)
  assert.equal(await onTestnet(wallet), true)
  assert.equal(methods.includes('eth_sendTransaction'), false)
})

test('receipt verification rejects mismatched transaction input and distinguishes a revert', async () => {
  const sender = '0x0000000000000000000000000000000000000010'
  const expected = { sender, metadataURI: 'ipfs://example', data: '0x24e615b301', value: '0x20' }
  assert.deepEqual(await readLaunchReceipt(async () => null, '0x01', expected), { state: 'pending' })
  function receiptRpc(input) {
    return async (method) => method === 'eth_getTransactionReceipt'
      ? { from: sender, to: factory, status: '0x0' }
      : { input, value: '0x20' }
  }
  assert.deepEqual(await readLaunchReceipt(receiptRpc('0x24e615b302'), '0x01', expected), { state: 'unverified' })
  assert.deepEqual(await readLaunchReceipt(receiptRpc(expected.data), '0x01', expected), { state: 'reverted' })
})

test('V6 metadata accepts the nested icon schema and rejects a mismatched creator', () => {
  const identity = { name: 'Pilot', symbol: 'PILOT', sender: '0x0000000000000000000000000000000000000010' }
  const uri = 'ipfs://bafkreide374f3cu45w4st3ipupaomw3vtmuv3iiucxloygxduo54jdibhy'
  const metadata = {
    chainId: 46630, schemaVersion: 1, name: identity.name, symbol: identity.symbol, creator: identity.sender,
    image: { uri, mimeType: 'image/webp', bytes: 28916, width: 512, height: 512 },
  }
  assert.equal(verifyMetadataDocument(metadata, identity), uri)
  assert.throws(() => verifyMetadataDocument({ ...metadata, creator: '0x0' }, identity), /must match/)
  assert.throws(() => verifyMetadataDocument({ ...metadata, image: uri }, identity), /public IPFS icon/)
})
