#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { runSniper } from "./sniper.js";

const HELP = `
ACO Sniper  -  Instant mint execution untuk Ethereum Mainnet (chainId = 1)

Penggunaan:
  npm start
  node src/index.js

Konfigurasi via .env (salin dari .env.example).

Filosofi:
  - Pre-flight (sebelum mint window): validasi chain, ABI, encode calldata,
    cache nonce + baseFee, optional pre-sign tx.
  - Hot path (saat trigger fire): broadcast paralel ke semua RPC, race
    Promise.any untuk first-success. No simulation, no prompt.

Trigger modes:
  TRIGGER_MODE=immediate  - fire saat skrip dijalankan
  TRIGGER_MODE=poll       - poll view fn sampai cocok TRIGGER_EXPECT
  TRIGGER_MODE=timestamp  - tunggu Unix timestamp tertentu
  TRIGGER_MODE=block      - tunggu block number tertentu

Keselamatan minimum (zero hot-path overhead):
  - Chain ID = 1 dipaku
  - Bytecode check di pre-flight
  - Dangerous function denylist (approve, transfer, burn, dst.)
  - Fee cap MAX_FEE_GWEI (override via SNIPER_BYPASS_FEE_CAP=true)
  - WAJIB pakai BURNER WALLET di PRIVATE_KEY
`;

(async () => {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  try {
    const cfg = loadConfig();
    await runSniper(cfg);
  } catch (err) {
    console.error("\nDIBATALKAN:", err.shortMessage || err.message);
    process.exit(1);
  }
})();
