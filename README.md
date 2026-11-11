# Vibe LaunchPilot

Prepare and launch Vibe/Vibe V6 ETH tokens on Robinhood Chain Testnet, track new launches, simulate trades and review testnet buys and sells in your browser wallet. Automatic entries and exits run in the paper session. Each on-chain trade requires wallet approval.

## Run locally

Use Node 24 or later. Run `npm ci` once and `npm run dev` from this folder. Open the local URL printed in the terminal. Run `npm test` for protocol checks and `npm run build` to build the static site.

## Try the example

1. Select **Load example**, then **Simulate on testnet**. The opening allocation puts the draft over its test ETH cap.
2. Select **Save as baseline** and change the opening allocation to **1000000**.
3. Simulate again. Review the new cap result and the difference from the baseline.

The browser reads live settings and rehearses the transaction at a specific block. Gas is estimated and the cap applies inside LaunchPilot. The loaded example is simulation-only.

## Creator Launch

1. Choose an injected wallet and connect a funded Robinhood Testnet account.
2. Fill in the token details. Prepare an icon and public metadata, or enter a matching V6 IPFS metadata URI you control.
3. Simulate the draft. If the gas reserve fits the cap, select **Launch on Vibe/Vibe** and review the transaction in the wallet.
4. After approval, LaunchPilot tracks the transaction and verifies the V6 factory receipt. It links to the token page, public IPFS metadata, explorer, and Vibe/Vibe's category management page when confirmed.

This version supports native ETH pairs without airdrops. Review the wallet fee before confirming. Vibe/Vibe manages token icons and category display. Launch submission requires a secure browser with Web Locks. Tabs at the same app address share a single pending launch and the last verified receipt. If the wallet result is unclear, use the recovery controls after checking wallet history.

### Local icon pinning

Set `PINATA_JWT` in a local `.env.local` next to this file or supply it as a server process environment variable. Restart the local dev or preview server. Create a non-admin Pinata key with only the legacy `pinFileToIPFS` permission. The local endpoint uses it to pin the icon and metadata separately. The application browser never receives the credential. Public hosting needs a separately authorized and rate-limited upload endpoint.

## Snipe Mode · Launch watch

Select **Start tracking** to read launches directly from the V6 factory on Robinhood Testnet. The first scan reads up to 250 blocks, ending four blocks behind the chain head. Results and scan position are saved in this browser. After reopening the app, select **Start tracking** again to catch up from the saved position. Tracking runs in the open tab and needs no wallet.

Select **Try paper trade** on an ETH pair or enter a V6 token address. Set the buy size, spend cap, maximum token age, tax, price impact and slippage, and check the live quote. **Open paper position** checks a new quote, records the minimum token output and monitors a full exit for take profit or stop loss. Exit decisions use the minimum quoted ETH after the modeled gas cost. One virtual position runs in the open tab and clears on reload. Gas is modeled using a fixed reserve and live gas price. Virtual fills leave real liquidity unchanged, so the sale quote can be unavailable even after a virtual buy.

**Automatic paper session** monitors V6 launches from the block after session start. Set the gas-inclusive buy cap, cumulative buy budget, maximum open positions, filters and TP/SL rules before starting. Waiting candidates are checked again until they age out, and each token can enter once. Buy costs stay charged to the session after exit. Exit share applies once per position and any remainder stays in the ledger. A closed curve blocks automatic exits for that position.

Pause stops the tab's polling. The settings, block cursor and ledger stay in this browser. Select **Resume paper session** to catch up after reopening. Only one tab can run the session at a time. The ledger can hold up to 500 launches before scanning stops. All positions and costs are simulated.

### Local launch worker

In this folder, run `npm run watch:worker` and open [the local status panel](http://127.0.0.1:4181/). Closing the browser tab leaves the worker running. Press **Ctrl+C** in its terminal to stop the process. Restarting the command resumes from `.worker-state/launch-watch.json` on this computer.

Robinhood’s public sequencer WebSocket prompts scans. The worker verifies V6 launch events over HTTP, scans four blocks behind the head and keeps the latest 30 launches. HTTP polling continues during a WebSocket outage. The local panel displays public data only. The browser's paper session remains separate and still runs in its own tab.

The worker's **Review buy in LaunchPilot** link opens the token draft on the app's local port. Start the app with `npm run dev -- --host 127.0.0.1 --port 4178 --strictPort` or set `LAUNCHPILOT_APP_PORT` for the worker to match another app port.

### Controlled testnet trade

Connect your existing browser wallet on Robinhood Chain Testnet in Creator Launch. In **Snipe Mode · Testnet trade**, choose Buy or Sell and enter a run19 V6 ETH token. **Review testnet buy** simulates the official execution zap and estimates gas. **Open wallet approval** rechecks the quote without lowering the reviewed minimum or increasing the reviewed cost. The wallet approves each transaction and can show its own fee settings. An uncertain submission stays in the browser until reconciled against wallet history and the on-chain receipt.

In **Launch watch**, choose **Review buy** to check the token against the current buy settings. A filled paper candidate offers **Review buy with these limits**, which copies the paper buy size and per-trade limits. The live preflight reads a new quote. The paper budget and positions stay in the simulated ledger.

For **Sell**, enter the token amount and a gas cap for each transaction. If allowance is insufficient, review the exact token allowance for the V6 execution zap and approve it in your wallet. After the allowance receipt is confirmed, select **Review testnet sell** again for a fresh quote. A verified sale shows the exact tokens debited, the ETH received before gas, the network fee and the balance at the receipt block.
