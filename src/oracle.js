import { ethers } from "ethers";

/**
 * On-chain gas oracle (Chainlink Fast Gas / Gwei feed) sebagai fallback
 * untuk estimasi biaya saat `eth_feeHistory` tidak tersedia.
 *
 * Catatan penting:
 *   Chainlink secara aktif melakukan deprekasi data feed lama. Modul ini
 *   secara defensif mendeteksi dua kondisi gagal:
 *     1. Feed sudah dimatikan (kontrak revert)        -> lempar error
 *     2. Feed stale (updatedAt > STALE_AFTER_SECONDS) -> lempar error
 *   Pemanggil bertanggung jawab untuk menangkap error ini dan jatuh ke
 *   fallback berikutnya (mis. provider.getFeeData()).
 *
 * Referensi alamat feed (Ethereum Mainnet):
 *   Fast Gas / Gwei -> 0x169E633A2D1E6c10dD91238Ba11c4A708dfEF37C
 */

export const CHAINLINK_FAST_GAS_FEED =
  "0x169E633A2D1E6c10dD91238Ba11c4A708dfEF37C";

const AGGREGATOR_V3_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
];

const STALE_AFTER_SECONDS = 60 * 60; // 1 jam

/**
 * Membaca harga gas dari Chainlink Fast Gas feed.
 *
 * Mengembalikan harga dalam **wei** (BigInt), sesuai konvensi Chainlink
 * untuk feed gas (decimals = 0, answer dalam wei).
 *
 * @returns {Promise<{gasPriceWei: bigint, updatedAt: number, ageSeconds: number, description: string}>}
 */
export async function readChainlinkFastGas(
  provider,
  address = CHAINLINK_FAST_GAS_FEED
) {
  // Pastikan kontrak masih ada (deteksi feed yang sudah selfdestruct/dipindahkan)
  const code = await provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error(
      `Chainlink Fast Gas feed di ${address} sudah tidak punya bytecode ` +
        `(kemungkinan dideprekasi). Lihat https://docs.chain.link/data-feeds/deprecating-feeds`
    );
  }

  const feed = new ethers.Contract(address, AGGREGATOR_V3_ABI, provider);

  let roundData;
  try {
    roundData = await feed.latestRoundData();
  } catch (err) {
    throw new Error(
      `Chainlink Fast Gas: latestRoundData() revert (${
        err.shortMessage || err.message
      }). Feed kemungkinan dideprekasi.`
    );
  }

  const answer = roundData[1];
  const updatedAt = Number(roundData[3]);

  if (answer <= 0n) {
    throw new Error(`Chainlink Fast Gas: nilai tidak valid (answer=${answer}).`);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const ageSeconds = nowSec - updatedAt;
  if (ageSeconds > STALE_AFTER_SECONDS) {
    throw new Error(
      `Chainlink Fast Gas: feed stale (umur ${ageSeconds}s > ` +
        `batas ${STALE_AFTER_SECONDS}s). Feed kemungkinan dideprekasi.`
    );
  }

  // Baca decimals untuk handle feed pengganti yang mungkin pakai konvensi
  // berbeda. Feed asli punya decimals=0 (answer = wei). Kalau feed baru
  // pakai decimals=9 (gwei), kita konversi otomatis.
  let decimals = 0;
  try {
    decimals = Number(await feed.decimals());
  } catch {
    /* fallback ke 0 */
  }

  let gasPriceWei;
  if (decimals === 0) {
    gasPriceWei = BigInt(answer);
  } else {
    // answer dalam unit 10^-decimals dari "gas price unit". Kita asumsikan
    // unit dasarnya gwei berdasarkan nama feed "Fast Gas / Gwei".
    // gasPriceWei = answer * 10^9 / 10^decimals
    const num = BigInt(answer) * 10n ** 9n;
    const denom = 10n ** BigInt(decimals);
    gasPriceWei = num / denom;
  }

  return {
    gasPriceWei,
    updatedAt,
    ageSeconds,
    decimals,
  };
}
