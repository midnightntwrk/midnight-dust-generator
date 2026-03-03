// This file is part of midnight-dust-generator.
// Copyright (C) 2025 Midnight Foundation
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0 (the "License");
// You may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//	https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Midnight DUST Generation Tutorial
 *
 * This script:
 *   1. Creates a new wallet or restores an existing one
 *   2. Displays all wallet addresses (shielded, unshielded, dust)
 *   3. Waits for you to send tNight from the faucet
 *   4. Registers your NIGHT tokens for DUST generation
 *   5. Monitors your DUST balance as it accrues
 */

// ─── Imports ───────────────────────────────────────────────────────────────────

// The Midnight wallet SDK communicates with the indexer over WebSockets. Node.js doesn't have a built-in WebSocket like browsers do, so we import one and set it globally before any wallet code runs.
import { WebSocket } from 'ws';
(globalThis as any).WebSocket = WebSocket;

// Buffer: converts hex strings to/from binary data (used for seeds and keys)
// readline: reads user input from the terminal (for the wallet create/restore prompt)
// rxjs: reactive streams library — the wallet SDK emits state updates as observables
import { Buffer } from 'buffer';
import * as readline from 'readline';
import * as Rx from 'rxjs';

// HD wallet — derives multiple key pairs from a single seed phrase
import { HDWallet, Roles, generateRandomSeed } from '@midnight-ntwrk/wallet-sdk-hd';

// Utility to convert binary data to hex stringsr
import { toHex } from '@midnight-ntwrk/midnight-js-utils';

// Ledger types — defines tokens, keys, and on-chain parameters
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v7';

// WalletFacade — combines the three sub-wallets into a single interface
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';

// ShieldedWallet — handles private (zero-knowledge) transactions
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';

// DustWallet — generates and spends DUST for transaction fees
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';

// UnshieldedWallet — handles transparent (public) transactions like receiving tNight
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import type { UnshieldedKeystore } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

// Network ID — tells the SDK which network to connect to (preprod, preview, etc.)
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

// Address formatting — encodes wallet keys into human-readable bech32m addresses
import {
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from '@midnight-ntwrk/wallet-sdk-address-format';


// ─── Configuration ─────────────────────────────────────────────────────────────
// Preprod network endpoints. The indexer and RPC node are public services hosted by Midnight. The proof server runs locally on your machine (via Docker) so that your private data never leaves your computer.

const CONFIG = {
  networkId: 'preprod' as const,
  indexerHttpUrl: 'https://indexer.preprod.midnight.network/api/v3/graphql',
  indexerWsUrl: 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws',
  node: 'https://rpc.preprod.midnight.network',
  proofServer: 'http://localhost:6300',
  faucetUrl: 'https://faucet.preprod.midnight.network',
};


// ─── Helper: Format raw balance to human-readable ──────────────────────────────
// Midnight balances use 6 decimal places. A raw value of 1,000,000,000 equals 1,000.000000 tokens.

const formatBalance = (raw: bigint): string => {
  const whole = raw / 1_000_000n;
  const fraction = (raw % 1_000_000n).toString().padStart(6, '0');
  return `${whole.toLocaleString()}.${fraction}`;
};


// ─── Helper: Clock Spinner ─────────────────────────────────────────────────────
// Shows a rotating clock animation in the terminal while an async operation runs.

const withStatus = async <T>(message: string, fn: () => Promise<T>): Promise<T> => {
  const clocks = ['🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛'];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r  ${clocks[i++ % clocks.length]} ${message}`);
  }, 150);
  try {
    const result = await fn();
    clearInterval(interval);
    process.stdout.write(`\r  ✅ ${message}\n`);
    return result;
  } catch (e) {
    clearInterval(interval);
    process.stdout.write(`\r  ❌ ${message}\n`);
    throw e;
  }
};


// ─── Helper: Prompt for user input ─────────────────────────────────────────────

const prompt = (question: string): Promise<string> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
};


// ─── Step 1: Create or Restore a Wallet Seed ───────────────────────────────────

const getOrCreateSeed = async (): Promise<string> => {
  const choice = await prompt('  Create a new wallet or restore an existing one? (n/r): ');

  if (choice.toLowerCase() === 'r') {
    const seed = await prompt('  Enter your seed: ');
    if (!seed || seed.length < 32) {
      throw new Error('Invalid seed. The seed should be a 64-character hex string.');
    }
    console.log('  Restoring wallet from seed...\n');
    return seed;
  }

  // Generate a brand new seed
  const seed = toHex(Buffer.from(generateRandomSeed()));
  console.log('\n  Created new wallet.');
  console.log('  ⚠️  Save this seed — it is the ONLY way to restore your wallet:\n');
  console.log(`  ${seed}\n`);
  return seed;
};


// ─── Step 2: Derive Keys from the Seed ─────────────────────────────────────────
// The HD wallet derives three sets of keys from a single seed:
//   - Zswap:         for shielded (private) transactions
//   - NightExternal: for unshielded (transparent) transactions
//   - Dust:          for DUST fee management

const deriveKeys = (seed: string) => {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') {
    throw new Error('Failed to initialize HDWallet from seed. Is the seed a valid hex string?');
  }

  const derivationResult = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (derivationResult.type !== 'keysDerived') {
    throw new Error('Failed to derive keys from seed.');
  }

  // Clear sensitive key material from memory
  hdWallet.hdWallet.clear();

  return derivationResult.keys;
};


// ─── Step 3: Build the Wallet ──────────────────────────────────────────────────
// Midnight uses three sub-wallets, each handling a different type of transaction. The WalletFacade ties them together into a single interface.

const buildWallet = async (keys: ReturnType<typeof deriveKeys>) => {
  setNetworkId(CONFIG.networkId);

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());

  // Shared config used by the shielded and dust wallets. Defined as a variable (rather than inline) so TypeScript doesn't raise strict excess-property errors when each wallet constructor only expects a subset of these fields.
  const walletBaseConfig = {
    networkId: getNetworkId(),
    indexerClientConnection: {
      indexerHttpUrl: CONFIG.indexerHttpUrl,
      indexerWsUrl: CONFIG.indexerWsUrl,
    },
    provingServerUrl: new URL(CONFIG.proofServer),
    relayURL: new URL(CONFIG.node.replace(/^http/, 'ws')),
  };

  // ── Shielded Wallet (private/ZK transactions) ──
  const shieldedWallet = ShieldedWallet(walletBaseConfig).startWithSecretKeys(shieldedSecretKeys);

  // ── Unshielded Wallet (transparent transactions) ──
  const unshieldedWallet = UnshieldedWallet({
    networkId: getNetworkId(),
    indexerClientConnection: walletBaseConfig.indexerClientConnection,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
  }).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));

  // ── Dust Wallet (fee generation and spending) ──
  const dustWallet = DustWallet({
    ...walletBaseConfig,
    costParameters: {
      additionalFeeOverhead: 300_000_000_000_000n,
      feeBlocksMargin: 5,
    },
  }).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust);

  // ── Create and start the unified facade ──
  const wallet = new WalletFacade(shieldedWallet, unshieldedWallet, dustWallet);
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
};


// ─── Step 4: Wait for the Wallet to Sync ───────────────────────────────────────

const waitForSync = (wallet: WalletFacade) =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(5_000),
      Rx.filter((state) => state.isSynced),
    ),
  );


// ─── Step 5: Wait for Incoming Funds ───────────────────────────────────────────

const waitForFunds = (wallet: WalletFacade): Promise<bigint> =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(10_000),
      Rx.filter((state) => state.isSynced),
      Rx.map((s) => s.unshielded.balances[unshieldedToken().raw] ?? 0n),
      Rx.filter((balance) => balance > 0n),
    ),
  );


// ─── Step 6: Register NIGHT Tokens for DUST Generation ─────────────────────────
// Your NIGHT tokens don't produce DUST until you explicitly register them via an on-chain transaction. The targetDustAddress parameter specifies which dust address will receive the generated DUST.

const registerForDustGeneration = async (
  wallet: WalletFacade,
  unshieldedKeystore: UnshieldedKeystore,
  targetDustAddress: string,
): Promise<void> => {
  const state = await Rx.firstValueFrom(
    wallet.state().pipe(Rx.filter((s) => s.isSynced)),
  );

  // Check: Do we already have DUST from a previous session?
  if (state.dust.availableCoins.length > 0) {
    const dustBalance = state.dust.walletBalance(new Date());
    console.log(`  DUST already available: ${formatBalance(dustBalance)}\n`);
    return;
  }

  // Find NIGHT UTXOs that haven't been registered yet
  const unregisteredCoins = state.unshielded.availableCoins.filter(
    (coin: any) => coin.meta?.registeredForDustGeneration !== true,
  );

  if (unregisteredCoins.length === 0) {
    console.log('  All NIGHT already registered. Waiting for DUST to generate...');
  } else {
    // Submit the registration transaction
    await withStatus(
     `Registering NIGHT for dust generation → ${targetDustAddress}`,
      async () => {
        const recipe = await wallet.registerNightUtxosForDustGeneration(
          unregisteredCoins,
          unshieldedKeystore.getPublicKey(),
          (payload) => unshieldedKeystore.signData(payload),
        );
        const finalized = await wallet.finalizeRecipe(recipe);
        await wallet.submitTransaction(finalized);
      },
    );
  }

  // Wait for DUST balance to become non-zero
  await withStatus('Waiting for DUST to generate (this may take 1–2 minutes)', () =>
    Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.throttleTime(5_000),
        Rx.filter((s) => s.isSynced),
        Rx.filter((s) => s.dust.walletBalance(new Date()) > 0n),
      ),
    ),
  );
};


// ─── Step 7: Check DUST Balance ────────────────────────────────────────────────
// DUST generates continuously over time. This function checks the current balance.

const checkDustBalance = async (wallet: WalletFacade): Promise<bigint> => {
  const state = await Rx.firstValueFrom(
    wallet.state().pipe(Rx.filter((s) => s.isSynced)),
  );
  return state.dust.walletBalance(new Date());
};


// ─── Main ──────────────────────────────────────────────────────────────────────

const main = async () => {
  // 1. Get or create a wallet seed
  console.log('');
  const seed = await getOrCreateSeed();

  // 2. Derive HD keys
  const keys = deriveKeys(seed);

  // 3. Build the wallet
  const { wallet, unshieldedKeystore } = await withStatus('Building wallet', () => buildWallet(keys));

  // 4. Display all wallet addresses immediately (derived from keys, available before sync)
  const initialState = await Rx.firstValueFrom(wallet.state());
  const networkId = getNetworkId();

  const coinPubKey = ShieldedCoinPublicKey.fromHexString(initialState.shielded.coinPublicKey.toHexString());
  const encPubKey = ShieldedEncryptionPublicKey.fromHexString(initialState.shielded.encryptionPublicKey.toHexString());
  const shieldedAddress = MidnightBech32m.encode(networkId, new ShieldedAddress(coinPubKey, encPubKey)).toString();
  const unshieldedAddress = unshieldedKeystore.getBech32Address();
  const dustAddress = initialState.dust.dustAddress;

  console.log('');
  console.log('  Wallet Addresses:');
  console.log(`    Shielded:    ${shieldedAddress}`);
  console.log(`    Unshielded:  ${unshieldedAddress}  ← send tNight here`);
  console.log(`    Dust:        ${dustAddress}`);
  console.log('');
  console.log(`  Faucet: ${CONFIG.faucetUrl}`);
  console.log('');

// 5. Ask which dust address to designate for DUST generation
  const dustInput = await prompt(`  Dust address to designate: `);
  const targetDustAddress = dustInput || dustAddress;

  if (targetDustAddress !== dustAddress) {
    console.log(`\n  Using external dust address: ${targetDustAddress}\n`);
  } else {
    console.log('');
  }

  // 6. Sync with the network
  await withStatus('Syncing wallet with network', () => waitForSync(wallet));

  const state = await Rx.firstValueFrom(wallet.state());

  // 7. Check balance — if zero, wait for faucet funds
  const currentBalance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;

  if (currentBalance === 0n) {
    console.log('  Waiting for tNight — copy the unshielded address above and paste it into the faucet.');
    console.log('  ⚠️  Make sure you copy only the address with no extra spaces.\n');
    const balance = await withStatus('Waiting for incoming tNight', () => waitForFunds(wallet));
    console.log(`  Balance: ${formatBalance(balance)} tNight\n`);
  } else {
    console.log(`  Balance: ${formatBalance(currentBalance)} tNight\n`);
  }

  // 8. Register NIGHT for DUST generation
await registerForDustGeneration(wallet, unshieldedKeystore, targetDustAddress);

  // 9. Show DUST balance
  const dustBalance = await checkDustBalance(wallet);
  console.log('');
  console.log(`  DUST Balance: ${formatBalance(dustBalance)}`);
  console.log('  DUST generates continuously over time.');
  console.log('  Press Enter to re-check, or type "q" to quit.\n');

  // 10. Let the user check the balance repeatedly
  let running = true;
  while (running) {
    const answer = await prompt('  > ');
    if (answer.toLowerCase() === 'q' || answer.toLowerCase() === 'quit' || answer.toLowerCase() === 'exit') {
      running = false;
    } else {
      const updated = await checkDustBalance(wallet);
      const time = new Date().toLocaleTimeString();
      console.log(`  [${time}] DUST Balance: ${formatBalance(updated)}\n`);
    }
  }

  console.log('');
  console.log('  To restore this wallet later, run the script again and choose "r".');
  console.log(`  Your seed: ${seed}`);
  console.log('');

  await wallet.stop();
  process.exit(0);
};

// Run
main().catch((err) => {
  console.error('\n  ❌ Error:', err.message || err);
  process.exit(1);
});
