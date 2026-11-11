import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiItem, toHex, zeroAddress } from 'viem'
import { executionZap } from './testnet-buy.ts'
import { reviewSell, sellReceipt } from './testnet-sell.ts'

const account = '0x0000000000000000000000000000000000000001'
const curve = '0x0000000000000000000000000000000000000002'
const token = '0x0000000000000000000000000000000000000003'
const hash = '0x' + 'ab'.repeat(32)
const base = { token, curve, size: '100', minimum: '25' }
const tx = { from: account, to: executionZap, data: '0x15d5cb8b', value: '0x0', gas: '0x100', gasPrice: '0x1' }
const transfer = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)')
const approval = parseAbiItem('event Approval(address indexed owner,address indexed spender,uint256 value)')
const zapped = parseAbiItem('event Zapped(address indexed actor,uint8 kind,address indexed market,address input,address output,uint256 amountIn,uint256 amountOut)')
const log = (event, address, indexed, data) => ({
  address, topics: encodeEventTopics({ abi: [event], eventName: event.name, args: indexed }),
  data: encodeAbiParameters(event.inputs.filter(input => !input.indexed), data),
})
const mock = (transaction, logs, tokenValue) => async (method, params) => {
  if (method === 'eth_getTransactionReceipt') return {
    from: account, to: transaction.to, status: '0x1', gasUsed: '0x10', effectiveGasPrice: '0x1', blockNumber: '0x20', logs,
  }
  if (method === 'eth_getTransactionByHash') return { input: transaction.data, value: '0x0' }
  assert.equal(method, 'eth_call')
  assert.equal(params[0].to, token)
  assert.equal(params[1], '0x20')
  return encodeAbiParameters([{ type: 'uint256' }], [tokenValue])
}

test('sale receipt reconciles actual token debit, minimum ETH and remaining balance', async () => {
  const entry = { ...base, kind: 'sell', transaction: tx }
  const zap = log(zapped, executionZap, { actor: account, market: curve }, [2, token, zeroAddress, 100n, 26n])
  const debit = log(transfer, token, { from: account, to: executionZap }, [100n])
  assert.deepEqual(await sellReceipt(entry, hash, mock(tx, [zap, debit], 50n)),
    { state: 'sold', size: 100n, amountOut: 26n, gasCost: 16n, balance: 50n })
  assert.equal((await sellReceipt(entry, hash, mock(tx, [zap], 50n))).state, 'unverified')
  assert.equal((await sellReceipt({ ...entry, minimum: '27' }, hash, mock(tx, [zap, debit], 50n))).state, 'unverified')
})

test('approval requires both the exact event amount and the exact on-chain allowance', async () => {
  const transaction = { ...tx, to: token, data: '0x095ea7b3' }
  const entry = { ...base, kind: 'approval', transaction }
  const event = log(approval, token, { owner: account, spender: executionZap }, [100n])
  assert.deepEqual(await sellReceipt(entry, hash, mock(transaction, [event], 100n)), { state: 'approved', gasCost: 16n })
  assert.equal((await sellReceipt(entry, hash, mock(transaction, [event], 101n))).state, 'unverified')
})

test('sale review prepares an exact approval only when allowance is insufficient', async () => {
  const abi = parseAbi([
    'function curveOf(address) view returns (address)',
    'function pairCurrency() view returns (address)',
    'function complete() view returns (bool)',
    'function createdAt() view returns (uint256)',
    'function sold() view returns (uint120)',
    'function currentRateBps() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function quoteSell(uint256) view returns (uint256,uint256,uint256,uint256)',
    'function approve(address,uint256) returns (bool)',
    'function sell(address,uint256,(address,address,uint24,int24,address)[],uint256,uint256,(address,uint256)[]) returns (uint256)',
  ])
  const timestamp = BigInt(Math.floor(Date.now() / 1000))
  let allowance = 99n
  const values = {
    curveOf: [curve], pairCurrency: [zeroAddress], complete: [false], createdAt: [timestamp],
    sold: [1000n], currentRateBps: [100n], balanceOf: [100n], quoteSell: [100n, 500n, 5n, 495n],
    approve: [true], sell: [495n],
  }
  const rpc = async (method, params) => {
    if (method === 'eth_chainId') return '0xb626'
    if (method === 'eth_getBlockByNumber') return { number: '0x20', timestamp: toHex(timestamp) }
    if (method === 'eth_gasPrice') return '0x1'
    if (method === 'eth_estimateGas') return '0x10'
    if (method === 'eth_getBalance') return '0x1000'
    assert.equal(method, 'eth_call')
    assert.equal(params[1], '0x20')
    const { functionName } = decodeFunctionData({ abi, data: params[0].data })
    const fn = abi.find(item => item.name === functionName)
    return encodeAbiParameters(fn.outputs, functionName === 'allowance' ? [allowance] : values[functionName])
  }
  const draft = { token, size: 100n, cap: 100n, slippage: 100n }
  const exact = await reviewSell(draft, account, rpc)
  assert.equal(exact.kind, 'approval')
  assert.equal(exact.transaction.to, token)
  assert.equal(exact.transaction.value, '0x0')
  assert.deepEqual(decodeFunctionData({ abi, data: exact.transaction.data }).args, [executionZap, draft.size])
  allowance = 100n
  await assert.rejects(reviewSell(draft, account, rpc, exact), /Allowance or curve changed/)
  const sale = await reviewSell(draft, account, rpc)
  assert.equal(sale.kind, 'sell')
  assert.equal(sale.transaction.to, executionZap)
  assert.equal(sale.minOut, 490n)
})
