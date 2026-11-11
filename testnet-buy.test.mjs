import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from 'viem'
import { buyReceipt, executionZap, restoreBuy } from './testnet-buy.ts'

test('buy recovery requires matching calldata and a buy event for the intended recipient', async () => {
  const account = '0x0000000000000000000000000000000000000001'
  const curve = '0x0000000000000000000000000000000000000002'
  const hash = '0x' + 'ab'.repeat(32)
  const transaction = { from: account, to: executionZap, data: '0x7681fb10', value: '0x64', gas: '0x100', gasPrice: '0x1' }
  const pending = restoreBuy(JSON.stringify({ transaction, curve, hash }))
  const event = parseAbiItem('event CurveBuy(address indexed buyer,address indexed recipient,uint256 grossTokens,uint256 netTokens,uint256 tokenFee,uint256 pairCost,uint256 pairFee,uint256 rateBps)')
  const log = {
    address: curve,
    topics: encodeEventTopics({ abi: [event], eventName: 'CurveBuy', args: { buyer: executionZap, recipient: account } }),
    data: encodeAbiParameters(event.inputs.filter(input => !input.indexed), [10n, 9n, 1n, 95n, 5n, 100n]),
  }
  const receipt = { from: account, to: executionZap, status: '0x1', gasUsed: '0x10', effectiveGasPrice: '0x2', logs: [log] }
  const rpc = (found, input = transaction.data) => async method => method === 'eth_getTransactionReceipt'
    ? found : { input, value: transaction.value }
  assert.deepEqual(await buyReceipt(pending, hash, rpc(receipt)), { state: 'confirmed', tokens: 9n, gasCost: 32n })
  assert.equal((await buyReceipt(pending, hash, rpc(receipt, '0xdeadbeef'))).state, 'unverified')
  assert.equal((await buyReceipt(pending, hash, rpc({ ...receipt, logs: [{ ...log, address: account }] }))).state, 'unverified')
  assert.equal((await buyReceipt(pending, hash, rpc(null))).state, 'pending')
  assert.equal((await buyReceipt(pending, hash, rpc({ ...receipt, status: '0x0' }))).state, 'reverted')
})
