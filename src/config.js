import "dotenv/config";

/**
 * Konfigurasi khusus Ethereum Mainnet (chainId = 1).
 * Tidak menerima konfigurasi chain lain.
 */
export const ETHEREUM_CHAIN_ID = 1n;

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

export function loadConfig() {
  return {
    // Jaringan
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

    // Strategi biaya (default disesuaikan untuk era post-Fusaka)
    maxFeeGwei: num("MAX_FEE_GWEI", 20, { min: 0 }),
    maxPriorityGwei: num("MAX_PRIORITY_GWEI", 1, { min: 0 }),
    maxTotalCostEth: num("MAX_TOTAL_COST_ETH", 0.05, { min: 0 }),
    feeHistoryBlocks: num("FEE_HISTORY_BLOCKS", 20, { min: 1, integer: true }),
    tipPercentile: num("TIP_PERCENTILE", 50, { min: 1, integer: true }),

    // Konfirmasi & retry
    confirmations: num("CONFIRMATIONS", 1, { min: 1, integer: true }),
    maxRetries: num("MAX_RETRIES", 3, { min: 1, integer: true }),
    retryDelayMs: num("RETRY_DELAY_MS", 1500, { min: 0, integer: true }),

    // Rantai fallback estimasi biaya
    useChainlinkFallback: bool("USE_CHAINLINK_FALLBACK", true),
    chainlinkFastGasFeed:
      process.env.CHAINLINK_FAST_GAS_FEED?.trim() ||
      "0x169E633A2D1E6c10dD91238Ba11c4A708dfEF37C",

    // MEV protection (informasi saja; aktif jika RPC_URL = endpoint Flashbots Protect)
    usingFlashbotsProtect: bool("USING_FLASHBOTS_PROTECT", false),
  };
}
