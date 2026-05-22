import "dotenv/config";

/**
 * Konfigurasi khusus Ethereum Mainnet (chainId = 1).
 * Tidak menerima konfigurasi chain lain.
 */
export const ETHEREUM_CHAIN_ID = 1n;

const VALID_TRIGGER_MODES = new Set([
  "immediate",
  "poll",
  "timestamp",
  "block",
]);

function req(name) {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`Variabel .env wajib hilang: ${name}`);
  return v.trim();
}

function num(name, def, { min, integer } = {}) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Nilai numerik tidak valid untuk ${name}: ${v}`);
  if (min !== undefined && n < min) {
    throw new Error(`${name} harus >= ${min}, dapat ${n}`);
  }
  if (integer && !Number.isInteger(n)) {
    throw new Error(`${name} harus bilangan bulat, dapat ${n}`);
  }
  return n;
}

function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "y"].includes(v.trim().toLowerCase());
}

function enumOf(name, validSet, def) {
  const v = (process.env[name] ?? def).trim().toLowerCase();
  if (!validSet.has(v)) {
    throw new Error(
      `${name}=${v} tidak valid. Pilih salah satu: ${[...validSet].join(", ")}`
    );
  }
  return v;
}

export function loadConfig() {
  return {
    // Jaringan & dompet
    rpcUrl: req("RPC_URL"),
    privateKey: req("PRIVATE_KEY"),

    // Target NFT
    nftContract: req("NFT_CONTRACT"), // alamat 0x... atau nama ENS
    mintFn: req("MINT_FN"),
    mintArgs: (process.env.MINT_ARGS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    mintPriceEth: process.env.MINT_PRICE_ETH ?? "0",
    quantity: num("QUANTITY", 1, { min: 1, integer: true }),

    // Hardening: izinkan MINT_FN yang berpotensi berbahaya (approve,
    // setApprovalForAll, dll). Default false.
    allowDangerousFn: bool("ALLOW_DANGEROUS_FN", false),

    // === Sniper config ===
    // Trigger detection: immediate | poll | timestamp | block
    triggerMode: enumOf("TRIGGER_MODE", VALID_TRIGGER_MODES, "immediate"),

    // Untuk TRIGGER_MODE=poll
    triggerFn: process.env.TRIGGER_FN?.trim() || "",
    triggerExpect: process.env.TRIGGER_EXPECT?.trim() ?? "true",
    pollMs: num("POLL_MS", 200, { min: 50, integer: true }),

    // Untuk TRIGGER_MODE=timestamp (Unix epoch detik)
    triggerTimestamp: num("TRIGGER_TIMESTAMP", 0, { min: 0, integer: true }),

    // Untuk TRIGGER_MODE=block
    triggerBlock: num("TRIGGER_BLOCK", 0, { min: 0, integer: true }),

    // Multi-RPC parallel broadcast — comma-separated URL tambahan
    extraRpcUrls: (process.env.EXTRA_RPC_URLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),

    // Static gas limit untuk skip estimateGas (~50-100ms saving)
    staticGasLimit: num("STATIC_GAS_LIMIT", 300000, { min: 21000, integer: true }),

    // Strategi fee
    maxFeeGwei: num("MAX_FEE_GWEI", 20, { min: 0 }),
    sniperPriorityGwei: num("SNIPER_PRIORITY_GWEI", 3, { min: 0 }),

    // Bypass MAX_FEE_GWEI cap kalau jaringan kongesti (HATI-HATI)
    sniperBypassFeeCap: bool("SNIPER_BYPASS_FEE_CAP", false),

    // Pre-sign tx di pre-flight untuk cut ~50-100ms dari hot path.
    // Hot path tinggal broadcast cached signed tx.
    preSignTx: bool("PRESIGN_TX", false),

    // Multiplier baseFee untuk pre-signed maxFee (default 5x ≈ 14 blok kongesti).
    preSignFeeMultiplier: num("PRESIGN_FEE_MULTIPLIER", 5, { min: 2, integer: true }),
  };
}
