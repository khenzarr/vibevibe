import assert from 'node:assert/strict'
import test from 'node:test'
import { checkExecutionSupport } from './wallet-automation.ts'

const account = '0x0000000000000000000000000000000000000001'
const provider = (read, chain = '0xb626') => ({
  async request({ method, params }) {
    if (method === 'eth_chainId') return chain
    if (method === 'eth_accounts') return [account]
    assert.equal(method, 'wallet_getSupportedExecutionPermissions')
    assert.deepEqual(params, [])
    return read()
  },
})

test('execution support reads only the active testnet and never asks for permissions', async () => {
  const reports = {
    'native-token-allowance': { chainIds: ['0xb626'], ruleTypes: ['expiry'] },
    'another-permission': { chainIds: ['0x1'], ruleTypes: [] },
  }
  assert.deepEqual(await checkExecutionSupport(provider(() => reports)), {
    state: 'reported', permissions: [{ type: 'native-token-allowance', rules: ['expiry'] }],
  })
  assert.deepEqual(await checkExecutionSupport(provider(() => assert.fail('queried wrong chain'), '0x1')), { state: 'wrong-network' })
})

test('unavailable, unsupported and malformed replies are distinguished', async () => {
  const fail = code => () => { throw Object.assign(new Error('RPC error'), { code }) }
  assert.deepEqual(await checkExecutionSupport(provider(fail(-32601))), { state: 'unsupported', code: -32601 })
  assert.deepEqual(await checkExecutionSupport(provider(fail(-32000))), { state: 'unavailable', code: -32000 })
  assert.deepEqual(await checkExecutionSupport(provider(() => ({ invalid: { chainIds: ['0xb626'] } }))), { state: 'unavailable' })
})
