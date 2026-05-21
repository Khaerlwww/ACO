import { ethers } from "ethers";
import { readChainlinkFastGas } from "./oracle.js";

/**
 * Estimasi tip (priority fee) berbasis `eth_feeHistory`.
 *
 * Mengambil persentil ke-N dari N blok terakhir, lalu rata-ratakan.
 * Ini lebih akurat untuk Ethereum Mainnet dibanding sekadar
 * `provider.getFeeData()` yang tergantung default node.
 */
export async function suggestTipFromHistory(provider, blocks, percentile) {
  const hist = await provider.send("eth_feeHistory", [
    "0x" + blocks.toString(16),
    "latest",
    [percentile],
  ]);

  const rewards = (hist.reward ?? [])
    .map((r) => (r && r[0] ? BigInt(r[0]) : 0n))
    .filter((x) => x > 0n);

  if (rewards.length === 0) {
    throw new Error("eth_feeHistory mengembalikan reward kosong.");
  }

  const sum = rewards.reduce((a, b) => a + b, 0n);
  return sum / BigInt(rewards.length);
}

/**
 * Rantai fallback estimasi biaya:
 *
 *   1. eth_feeHistory                 (paling akurat)
 *   2. Chainlink Fast Gas oracle      (on-chain, deteksi stale & decommissioned)
 *   3. provider.getFeeData()          (fallback terakhir; data dari node)
 *
 * Setiap fallback hanya dipakai kalau yang sebelumnya melempar error.
 *
 * Hasil:
 *   { tip: bigint, source: string, isAbsoluteGasPrice?: boolean }
 *
 * Jika `isAbsoluteGasPrice = true`, nilai `tip` adalah TOTAL gas price
 * yang direkomendasikan (bukan hanya tip), sehingga pemanggil harus
 * menurunkan tip = totalGasPrice - baseFee.
 */
export async function estimateFee(provider, cfg) {
  const errors = [];

  // 1. eth_feeHistory
  try {
    const tip = await suggestTipFromHistory(
      provider,
      cfg.feeHistoryBlocks,
      cfg.tipPercentile
    );
    return { tip, source: `eth_feeHistory (p${cfg.tipPercentile})` };
  } catch (err) {
    errors.push(`feeHistory: ${err.shortMessage || err.message}`);
  }

  // 2. Chainlink Fast Gas oracle (on-chain)
  if (cfg.useChainlinkFallback) {
    try {
      const cl = await readChainlinkFastGas(provider, cfg.chainlinkFastGasFeed);
      return {
        tip: cl.gasPriceWei,
        source: `chainlink-fast-gas (umur ${cl.ageSeconds}s)`,
        isAbsoluteGasPrice: true,
      };
    } catch (err) {
      errors.push(`chainlink: ${err.shortMessage || err.message}`);
    }
  }

  // 3. provider.getFeeData()
  try {
    const fd = await provider.getFeeData();
    if (fd.maxPriorityFeePerGas && fd.maxPriorityFeePerGas > 0n) {
      return { tip: fd.maxPriorityFeePerGas, source: "getFeeData (EIP-1559)" };
    }
    if (fd.gasPrice && fd.gasPrice > 0n) {
      return {
        tip: fd.gasPrice,
        source: "getFeeData (legacy)",
        isAbsoluteGasPrice: true,
      };
    }
    errors.push("getFeeData: nilai 0 / null");
  } catch (err) {
    errors.push(`getFeeData: ${err.shortMessage || err.message}`);
  }

  throw new Error(
    "Semua sumber estimasi biaya gagal:\n  - " + errors.join("\n  - ")
  );
}

/**
 * Membentuk strategi fee EIP-1559 untuk Ethereum:
 *   maxPriorityFeePerGas = tip dari rantai fallback (di-clamp ke MAX_PRIORITY_GWEI)
 *   maxFeePerGas         = (baseFee * 2) + tip, di-clamp ke MAX_FEE_GWEI
 *
 * Faktor 2x pada baseFee memberi ruang lonjakan ~6 blok ke depan
 * (baseFee maksimum naik 12.5% per blok, jadi 1.125^6 ~= 2.03).
 */
export async function buildEthereumFees(provider, cfg) {
  const block = await provider.getBlock("latest");
  if (!block || block.baseFeePerGas == null) {
    throw new Error("Block terbaru tidak punya baseFeePerGas. Apakah benar Ethereum?");
  }
  const baseFee = block.baseFeePerGas;

  const est = await estimateFee(provider, cfg);

  // Lantai tip dibuat sangat kecil (0.01 gwei) supaya tetap relevan
  // untuk era post-Fusaka di mana baseFee biasanya < 1 gwei. Pengguna
  // tetap bisa menetapkan MAX_PRIORITY_GWEI lebih tinggi sesuai kondisi.
  const minTip = 10_000_000n; // 0.01 gwei
  const maxPrioCap = ethers.parseUnits(String(cfg.maxPriorityGwei), "gwei");
  const maxFeeCap = ethers.parseUnits(String(cfg.maxFeeGwei), "gwei");

  let tip;
  if (est.isAbsoluteGasPrice) {
    // Sumber memberi total gas price (mis. Chainlink Fast Gas atau legacy gasPrice).
    // Turunkan tip = total - baseFee, dengan lantai minTip.
    tip = est.tip > baseFee ? est.tip - baseFee : minTip;
  } else {
    tip = est.tip;
  }

  // Clamp tip: cap pengguna selalu menang. Lantai minTip hanya berlaku
  // jika cap >= minTip (biar pengguna yang sengaja set cap rendah dihormati).
  if (maxPrioCap >= minTip && tip < minTip) tip = minTip;
  if (tip > maxPrioCap) tip = maxPrioCap;

  const proposedMaxFee = baseFee * 2n + tip;
  if (proposedMaxFee > maxFeeCap) {
    throw new Error(
      `Estimasi maxFeePerGas ${ethers.formatUnits(proposedMaxFee, "gwei")} gwei ` +
        `melebihi batas MAX_FEE_GWEI=${cfg.maxFeeGwei}. ` +
        `Tunggu gas turun atau naikkan batas.`
    );
  }

  return {
    baseFee,
    tipFromSource: est.isAbsoluteGasPrice ? tip : est.tip,
    feeSource: est.source,
    maxPriorityFeePerGas: tip,
    maxFeePerGas: proposedMaxFee,
  };
}

/**
 * `staticCall` ke state aktual. Kalau revert di sini, transaksi nyata
 * juga akan revert dan membakar gas. Ini gerbang wajib sebelum kirim.
 */
export async function simulate({ provider, wallet, target, args, value }) {
  const data = target.iface.encodeFunctionData(target.fragment, args);
  const tx = { from: wallet.address, to: target.address, data, value };

  try {
    await provider.call(tx);
  } catch (err) {
    const reason = err?.shortMessage || err?.info?.error?.message || err?.message;
    throw new Error(`Simulasi revert: ${reason}`);
  }

  const gasLimit = await provider.estimateGas(tx);
  return { data, tx, gasLimit };
}

/**
 * Penegakan batas biaya total. Dipanggil setelah strategi fee dibentuk.
 */
export function enforceTotalCostCap({ fees, gasLimit, value, cfg }) {
  const gasCost = gasLimit * fees.maxFeePerGas;
  const totalCost = gasCost + value;
  const totalCap = ethers.parseEther(String(cfg.maxTotalCostEth));

  if (totalCost > totalCap) {
    throw new Error(
      `Total biaya ${ethers.formatEther(totalCost)} ETH melebihi batas ` +
        `MAX_TOTAL_COST_ETH=${cfg.maxTotalCostEth}.`
    );
  }
  return { gasCost, totalCost };
}
