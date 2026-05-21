#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { runAco } from "./aco.js";

function parseArgs(argv) {
  const args = { send: false };
  for (const a of argv.slice(2)) {
    if (a === "--send") args.send = true;
    else if (a === "--dry-run") args.send = false;
    else if (a === "-h" || a === "--help") args.help = true;
  }
  return args;
}

const HELP = `
aco-nft  -  Auto Checkout / Auto Mint NFT untuk Ethereum Mainnet (chainId = 1)

Penggunaan:
  node src/index.js              # dry-run (default): simulasi saja, tidak kirim
  node src/index.js --send       # simulasi, tanya y/N, lalu broadcast
  node src/index.js --dry-run    # paksa dry-run

Konfigurasi via .env (salin dari .env.example).
Skrip menolak: chain != 1, alamat tanpa bytecode, simulasi revert,
biaya melebihi batas. Selalu gunakan BURNER WALLET sesuai konvensi.
`;

(async () => {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(HELP);
    return;
  }
  try {
    const cfg = loadConfig();
    await runAco(cfg, { send: args.send });
  } catch (err) {
    console.error("\nDIBATALKAN:", err.shortMessage || err.message);
    process.exit(1);
  }
})();
