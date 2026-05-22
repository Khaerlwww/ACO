#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { runAco } from "./aco.js";
import { runSniper } from "./sniper.js";

function parseArgs(argv) {
  const args = { mode: "dry" };
  for (const a of argv.slice(2)) {
    if (a === "--send") args.mode = "send";
    else if (a === "--dry-run") args.mode = "dry";
    else if (a === "--sniper") args.mode = "sniper";
    else if (a === "-h" || a === "--help") args.help = true;
  }
  return args;
}

const HELP = `
ACO  -  Auto Checkout / Mint NFT untuk Ethereum Mainnet (chainId = 1)

MODE PENGGUNAAN:

  Mode aman (review/eksplorasi):
    node src/index.js              # dry-run: simulasi saja, tidak kirim
    node src/index.js --dry-run    # paksa dry-run
    node src/index.js --send       # simulasi -> y/N -> broadcast

  Mode sniper (instant execution, tanpa simulasi/prompt):
    node src/index.js --sniper     # trigger detection -> sign -> parallel broadcast

KONFIGURASI:
  Salin .env.example ke .env, lalu isi sesuai kebutuhan.

  Untuk mode aman: cukup RPC_URL, PRIVATE_KEY, NFT_CONTRACT, MINT_FN, MINT_ARGS.

  Untuk mode sniper, tambahkan minimal:
    TRIGGER_MODE=immediate|poll|timestamp|block
    EXTRA_RPC_URLS=...   (opsional, untuk parallel broadcast)
    STATIC_GAS_LIMIT=300000
    SNIPER_PRIORITY_GWEI=3

KESELAMATAN:
  - Skrip menolak chain != 1, alamat tanpa bytecode, MINT_FN berbahaya.
  - SELALU gunakan BURNER WALLET di PRIVATE_KEY.
`;

(async () => {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(HELP);
    return;
  }
  try {
    const cfg = loadConfig();
    if (args.mode === "sniper") {
      await runSniper(cfg);
    } else {
      await runAco(cfg, { send: args.mode === "send" });
    }
  } catch (err) {
    console.error("\nDIBATALKAN:", err.shortMessage || err.message);
    process.exit(1);
  }
})();
