# Midnight DUST Generator

This project is built on the [Midnight Network](https://midnight.network).

Generate DUST tokens programmatically on the Midnight Preprod network.

DUST is the non-transferable resource used to pay transaction fees on Midnight. Unlike Testnet-02 where DUST was available directly from the faucet, Preprod requires you to hold tNIGHT tokens and register them for DUST generation — the same flow used on Mainnet.

This script handles the full process: creating or restoring a wallet, funding it with tNIGHT from the faucet, designating a dust address, and registering your tokens to start generating DUST.

## Prerequisites

Midnight development is supported on **macOS and Linux only**.

- [Node.js](https://nodejs.org/) v18 or later
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — runs the proof server locally

```bash
node --version    # v18.x.x or higher
npm --version     # 9.x.x or higher
docker --version  # Docker version 2x.x.x or higher
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Start the proof server

Open a second terminal and run:

```bash
docker compose -f proof-server.yml up
```

Wait for `listening on: 0.0.0.0:6300` before continuing.

> **Mac ARM (Apple Silicon) users:** If the proof server hangs, open Docker Desktop → Settings → General → Virtual Machine Options → select **Docker VMM**. Restart Docker and try again.

### 3. Run the script

```bash
npm start
```

The script walks you through each step interactively:

```
  Create a new wallet or restore an existing one? (n/r): n

  Created new wallet.
  ⚠️  Save this seed — it is the ONLY way to restore your wallet:

  a1b2c3d4e5f6...

  ✅ Building wallet

  Wallet Addresses:
    Shielded:    mn_shield-addr_preprod1q...
    Unshielded:  mn_addr_preprod1q...  ← send tNight here
    Dust:        mn_dust_preprod1w...

  Faucet: https://faucet.preprod.midnight.network

  Dust address to designate:
```

### 4. Fund the wallet

1. Copy the **unshielded address** — make sure there are no extra spaces
2. Open the [Preprod faucet](https://faucet.preprod.midnight.network)
3. Paste the address and request tNIGHT tokens
4. The script detects incoming funds automatically

### 5. Generate DUST

Once funded, the script registers your tNIGHT and begins generating DUST:

```
  ✅ Registering NIGHT for dust generation → mn_dust_preprod1w...
  ✅ Waiting for DUST to generate (this may take 1–2 minutes)

  DUST Balance: 405,083.000000
  DUST generates continuously over time.
  Press Enter to re-check, or type "q" to quit.
```

Press Enter at any time to check your updated balance.

## Project Structure

```
midnight-dust-generator/
├── src/
│   └── index.ts            ← main script
├── package.json            ← dependencies and start script
├── proof-server.yml        ← Docker config for proof server
└── README.md
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Cannot find module` errors | Run `npm install`. If it persists, delete `node_modules` and `package-lock.json`, then reinstall. |
| Connection refused on port 6300 | Start the proof server: `docker compose -f proof-server.yml up` |
| Proof server hangs | Make sure Docker Desktop is running. On Apple Silicon, switch to Docker VMM in Docker Desktop settings. |
| Faucet says address is invalid | Copy only the address with no extra spaces. It should start with `mn_addr_preprod1`. |
| Balance stays at zero after faucet | Wait 30–60 seconds. The wallet polls the network periodically. |
| DUST stays at zero after registration | Initial generation can take 1–2 minutes. Verify the proof server is running at `http://localhost:6300`. |
| DUST drops to zero after a failed transaction | Known issue in wallet-sdk-facade 1.0.0. Restart the script to release locked DUST. |

## Restoring a Wallet

Run `npm start` again and choose `r` to restore from a saved seed. The script will sync and show your existing balances.

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
