import { onTestnet, walletAccount, walletErrorCode, type WalletProvider } from './wallet.ts'

export async function checkExecutionSupport(provider: WalletProvider) {
  if (!await onTestnet(provider)) return { state: 'wrong-network' } as const
  const account = await walletAccount(provider)
  let response: unknown
  try {
    response = await provider.request({ method: 'wallet_getSupportedExecutionPermissions', params: [] })
  } catch (error) {
    const code = walletErrorCode(error)
    if (code === -32601 || code === 4200) return { state: 'unsupported', code } as const
    return { state: 'unavailable', code } as const
  }
  if (!await onTestnet(provider) || (await walletAccount(provider)).toLowerCase() !== account.toLowerCase()) {
    return { state: 'changed' } as const
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)) return { state: 'unavailable' } as const
  const permissions: { type: string; rules: string[] }[] = []
  for (const [type, value] of Object.entries(response)) {
    if (!value || !Array.isArray(value.chainIds) || !Array.isArray(value.ruleTypes)
      || !value.ruleTypes.every((rule: unknown) => typeof rule === 'string')) return { state: 'unavailable' } as const
    if (value.chainIds.some((id: unknown) => typeof id === 'string' && /^0x[0-9a-f]+$/i.test(id) && BigInt(id) === 46630n)) {
      permissions.push({ type, rules: value.ruleTypes })
    }
  }
  return { state: 'reported', permissions } as const
}
