import { isAddress, type Address } from 'viem'
import { quantity } from './protocol.ts'

export const walletActionLock = 'launchpilot.creator.transaction'

export interface WalletProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  on?(event: string, listener: () => void): void
  removeListener?(event: string, listener: () => void): void
}

export interface WalletOption {
  name: string
  provider: WalletProvider
}

export function discoverWallets(add: (wallet: WalletOption) => void) {
  window.addEventListener('eip6963:announceProvider', (event) => {
    const detail = (event as CustomEvent).detail
    if (typeof detail?.provider?.request !== 'function' || typeof detail.info?.name !== 'string') return
    add({ name: detail.info.name.slice(0, 60), provider: detail.provider })
  })
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  return () => {
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    const provider = (window as Window & { ethereum?: WalletProvider }).ethereum
    if (typeof provider?.request === 'function') add({ name: 'Browser wallet', provider })
  }
}

export async function walletAccount(provider: WalletProvider, requestAccess = false): Promise<Address> {
  const accounts = await provider.request({ method: requestAccess ? 'eth_requestAccounts' : 'eth_accounts' })
  const first = Array.isArray(accounts) ? accounts[0] : undefined
  if (typeof first !== 'string' || !isAddress(first, { strict: false })) throw new Error('Select an account in your wallet.')
  return first
}

export async function onTestnet(provider: WalletProvider) {
  return quantity(await provider.request({ method: 'eth_chainId' })) === 46630n
}

export function walletErrorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? Number(error.code) : undefined
}

export async function switchToTestnet(provider: WalletProvider) {
  const chainId = '0xb626'
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
  } catch (error) {
    if (walletErrorCode(error) !== 4902) throw error
    await provider.request({
      method: 'wallet_addEthereumChain', params: [{
        chainId, chainName: 'Robinhood Chain Testnet',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: ['https://rpc.testnet.chain.robinhood.com'],
        blockExplorerUrls: ['https://explorer.testnet.chain.robinhood.com'],
      }],
    })
    if (!await onTestnet(provider)) await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] })
  }
}
