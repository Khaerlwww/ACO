import { ethers } from "ethers";

import { buildProviderAndWallet } from "./provider.js";
import { loadTarget, buildArgs } from "./contract.js";

/**
 * Sniper mode — instant mint execution dengan latensi minimum.
 *
 * Filosofi:
 *   - Semua validasi mahal dilakukan SEKALI di pre-flight, sebelum mint window
 *   - Hot path (saat mint live): nonce -> gas -> sign -> parallel broadcast
 *   - Tidak ada simulasi, prompt, atau dry-run di sini
 *   - Multi-RPC parallel broadcast untuk inclusion rate maksimum
 *
 * Mode trigger:
 *   - immediate  : fire langsung saat skrip dijalankan
 *   - poll       : poll view function, fire saat return value cocok TRIGGER_EXPECT
 *   - timestamp  : tunggu sampai Unix timestamp tertentu, lalu fire
 *   - block      : tunggu sampai blockNumber >= TRIGGER_BLOCK, lalu fire
 */

/**
 * Pre-flight: lakukan SEKALI sebelum mint window. Validasi mahal,
 * resolve ENS, build ABI, encode calldata, cache nonce & baseFee.
 * Hot path nantinya tidak menyentuh ini lagi.
 */
async function preflight(cfg) {
  const t0 = Date.now();
  const log = (msg) => console.log(`[preflight +${Date.now() - t0}ms]`, msg);

  // 1. Provider utama + wallet (chainId guard di sini)
  const { provider, wallet } = await buildProviderAndWallet(cfg);
  log(`wallet ${wallet.address}`);

  // 2. Provider tambahan untuk parallel broadcast (kalau ada)
  const extraProviders = cfg.extraRpcUrls
    .map((url) => {
      try {
        return new ethers.JsonRpcProvider(url);
      } catch (err) {
        console.warn(`[preflight] skip RPC ${url}: ${err.message}`);
        return null;
      }
    })
    .filter(Boolean);
  const broadcastProviders = [provider, ...extraProviders];
  log(`broadcast providers: ${broadcastProviders.length}`);

  // 3. Resolve target + bytecode + ABI fragment + denylist
  const target = await loadTarget(provider, cfg.nftContract, cfg.mintFn, {
    allowDangerousFn: cfg.allowDangerousFn,
  });
  const args = buildArgs(cfg.mintArgs, target.fragment, wallet.address);
  log(`target ${target.address} fn=${target.fragment.name}`);

  // 4. Encode calldata sekali — tidak akan berubah di hot path
  const data = target.iface.encodeFunctionData(target.fragment, args);
  const value =
    ethers.parseEther(String(cfg.mintPriceEth)) * BigInt(cfg.quantity);
  log(
    `calldata ready (${(data.length - 2) / 2} bytes)  value=${ethers.formatEther(value)} ETH`
  );

  // 5. Pre-fetch nonce & baseFee paralel
  const [nonce, block] = await Promise.all([
    provider.getTransactionCount(wallet.address, "pending"),
    provider.getBlock("latest"),
  ]);
  if (!block || block.baseFeePerGas == null) {
    throw new Error("Block terbaru tidak punya baseFeePerGas. Apakah benar Ethereum?");
  }
  log(
    `nonce=${nonce}  baseFee=${ethers.formatUnits(block.baseFeePerGas, "gwei")} gwei`
  );

  // 6. Build trigger detector untuk mode poll
  let triggerView = null;
  let triggerCallData = null;
  let triggerIface = null;
  if (cfg.triggerMode === "poll") {
    if (!cfg.triggerFn) throw new Error("TRIGGER_FN wajib untuk TRIGGER_MODE=poll");
    const sig = cfg.triggerFn.startsWith("function ")
      ? cfg.triggerFn
      : `function ${cfg.triggerFn}`;
    triggerIface = new ethers.Interface([sig]);
    triggerView = triggerIface.fragments[0];
    if (triggerView.inputs.length !== 0) {
      throw new Error("TRIGGER_FN harus fungsi tanpa argumen (mis. mintActive() returns (bool))");
    }
    triggerCallData = triggerIface.encodeFunctionData(triggerView.name, []);
    log(`trigger poll: ${triggerView.format("full")} expect=${cfg.triggerExpect}`);
  }

  return {
    wallet,
    provider,
    broadcastProviders,
    target,
    data,
    value,
    initialNonce: nonce,
    initialBaseFee: block.baseFeePerGas,
    triggerIface,
    triggerView,
    triggerCallData,
    cfg,
  };
}

/**
 * Tunggu sampai trigger condition terpenuhi.
 */
async function waitForTrigger(ctx) {
  const { cfg, provider, target, triggerIface, triggerView, triggerCallData } = ctx;

  if (cfg.triggerMode === "immediate") {
    return;
  }

  if (cfg.triggerMode === "timestamp") {
    if (!cfg.triggerTimestamp) throw new Error("TRIGGER_TIMESTAMP wajib untuk mode timestamp");
    const targetMs = cfg.triggerTimestamp * 1000;
    const waitMs = targetMs - Date.now();
    if (waitMs > 0) {
      console.log(
        `[trigger] menunggu ${(waitMs / 1000).toFixed(1)}s sampai ${new Date(targetMs).toISOString()}`
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
    console.log("[trigger] timestamp tercapai, fire");
    return;
  }

  if (cfg.triggerMode === "block") {
    if (!cfg.triggerBlock) throw new Error("TRIGGER_BLOCK wajib untuk mode block");
    const targetBlock = cfg.triggerBlock;
    while (true) {
      const cur = await provider.getBlockNumber();
      if (cur >= targetBlock) {
        console.log(`[trigger] block ${cur} >= ${targetBlock}, fire`);
        return;
      }
      await new Promise((r) => setTimeout(r, cfg.pollMs));
    }
  }

  if (cfg.triggerMode === "poll") {
    const expectStr = String(cfg.triggerExpect).toLowerCase();
    let pollCount = 0;
    while (true) {
      pollCount++;
      try {
        const ret = await provider.call({ to: target.address, data: triggerCallData });
        const decoded = triggerIface.decodeFunctionResult(triggerView.name, ret);
        const val = String(decoded[0]).toLowerCase();
        if (val === expectStr) {
          console.log(`\n[trigger] poll ${triggerView.name}() = ${val} ✓ fire (poll #${pollCount})`);
          return;
        }
        if (pollCount % 10 === 0) {
          process.stdout.write(`[poll #${pollCount}: ${val}] `);
        }
      } catch (err) {
        if (pollCount % 10 === 0) {
          process.stdout.write(`[poll #${pollCount}: err] `);
        }
      }
      await new Promise((r) => setTimeout(r, cfg.pollMs));
    }
  }

  throw new Error(`TRIGGER_MODE tidak dikenal: ${cfg.triggerMode}`);
}

/**
 * Hot path — dijalankan TEPAT saat trigger menyala.
 * Tidak ada simulasi, tidak ada prompt. Hanya: nonce → gas → sign → broadcast.
 */
async function hotPath(ctx) {
  const { wallet, provider, broadcastProviders, target, data, value, cfg } = ctx;
  const t0 = Date.now();

  // Refresh nonce & baseFee paralel
  const [freshNonce, latestBlock] = await Promise.all([
    provider.getTransactionCount(wallet.address, "pending"),
    provider.getBlock("latest"),
  ]);
  const baseFee = latestBlock.baseFeePerGas;
  console.log(
    `[hot +${Date.now() - t0}ms] nonce=${freshNonce} baseFee=${ethers.formatUnits(baseFee, "gwei")}gw`
  );

  // Aggressive fee: 3x baseFee + tip, dengan hard cap (kecuali bypass)
  const tip = ethers.parseUnits(String(cfg.sniperPriorityGwei), "gwei");
  const maxFeeCap = ethers.parseUnits(String(cfg.maxFeeGwei), "gwei");
  let maxFee = baseFee * 3n + tip;
  if (maxFee > maxFeeCap) {
    if (!cfg.sniperBypassFeeCap) {
      throw new Error(
        `[sniper] maxFee ${ethers.formatUnits(maxFee, "gwei")}gw > MAX_FEE_GWEI=${cfg.maxFeeGwei}. ` +
          `Set SNIPER_BYPASS_FEE_CAP=true kalau Anda mau yolo (HATI-HATI).`
      );
    }
    console.warn(`[sniper] maxFee melebihi cap, dipakai apa adanya (BYPASS aktif)`);
  }

  const gasLimit = BigInt(cfg.staticGasLimit);

  const txReq = {
    to: target.address,
    data,
    value,
    gasLimit,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: tip,
    chainId: 1,
    type: 2,
    nonce: freshNonce,
  };

  const t1 = Date.now();
  const signedTx = await wallet.signTransaction(txReq);
  console.log(`[hot +${Date.now() - t0}ms] signed (${Date.now() - t1}ms)`);

  // Parallel broadcast ke semua RPC
  const t2 = Date.now();
  const sends = broadcastProviders.map((p, i) =>
    p
      .broadcastTransaction(signedTx)
      .then((res) => ({ ok: true, idx: i, hash: res.hash, ms: Date.now() - t2 }))
      .catch((err) => ({
        ok: false,
        idx: i,
        error: err.shortMessage || err.message,
        ms: Date.now() - t2,
      }))
  );
  const results = await Promise.all(sends);

  console.log(`[hot +${Date.now() - t0}ms] broadcast results:`);
  for (const r of results) {
    if (r.ok) {
      console.log(`  RPC[${r.idx}] OK   ${r.ms}ms  hash=${r.hash}`);
    } else {
      console.log(`  RPC[${r.idx}] FAIL ${r.ms}ms  ${r.error}`);
    }
  }

  const accepted = results.find((r) => r.ok);
  if (!accepted) {
    throw new Error("Semua RPC menolak tx. Cek pesan error di atas.");
  }
  console.log(`[hot +${Date.now() - t0}ms] tx accepted: ${accepted.hash}`);
  console.log(`etherscan: https://etherscan.io/tx/${accepted.hash}`);

  if (cfg.waitForConfirmation) {
    console.log(`[wait] menunggu konfirmasi blok...`);
    const rc = await provider.waitForTransaction(accepted.hash, 1);
    if (!rc) {
      throw new Error(`Tx ${accepted.hash} tidak pernah mendapat konfirmasi`);
    }
    console.log(
      `[done] status=${rc.status === 1 ? "SUKSES" : "GAGAL"} block=${rc.blockNumber} gasUsed=${rc.gasUsed}`
    );
    return { hash: accepted.hash, receipt: rc };
  }

  console.log("[done] fire-and-forget — cek tx di Etherscan untuk konfirmasi akhir");
  return { hash: accepted.hash, receipt: null };
}

export async function runSniper(cfg) {
  console.log("=== ACO SNIPER (Ethereum Mainnet) ===");
  console.log(
    `mode=${cfg.triggerMode}  static-gas=${cfg.staticGasLimit}  bypass-fee-cap=${cfg.sniperBypassFeeCap}`
  );

  const ctx = await preflight(cfg);
  console.log("--- pre-flight selesai, tunggu trigger ---\n");

  await waitForTrigger(ctx);
  console.log("\n--- TRIGGER FIRE — masuk hot path ---");

  return hotPath(ctx);
}
