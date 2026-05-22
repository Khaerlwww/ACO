import { ethers } from "ethers";

import { buildProviderAndWallet } from "./provider.js";
import { loadTarget, buildArgs } from "./contract.js";
import { ETHEREUM_CHAIN_ID } from "./config.js";

/**
 * ACO Sniper — instant mint execution dengan latensi minimum.
 *
 * Filosofi:
 *   - Semua validasi mahal dilakukan SEKALI di pre-flight, sebelum mint window
 *   - Hot path (saat mint live): nonce -> gas -> sign -> parallel broadcast
 *   - Tidak ada simulasi, prompt, atau dry-run
 *   - Multi-RPC parallel broadcast dengan first-success race (Promise.any)
 *   - Fire-and-forget: return setelah RPC accept hash, tidak tunggu konfirmasi
 *
 * Mode trigger:
 *   - immediate  : fire langsung saat skrip dijalankan
 *   - poll       : poll view function, fire saat return value cocok TRIGGER_EXPECT
 *   - timestamp  : tunggu sampai Unix timestamp tertentu, lalu fire
 *   - block      : tunggu sampai blockNumber >= TRIGGER_BLOCK, lalu fire
 */

/**
 * Hitung strategi fee EIP-1559: maxFee = (baseFee × multiplier) + tip,
 * dengan hard cap MAX_FEE_GWEI kecuali bypass aktif.
 */
function computeFees(baseFee, cfg, multiplier) {
  const tip = ethers.parseUnits(String(cfg.sniperPriorityGwei), "gwei");
  const maxFeeCap = ethers.parseUnits(String(cfg.maxFeeGwei), "gwei");
  let maxFee = baseFee * BigInt(multiplier) + tip;
  let bypassWarning = null;
  if (maxFee > maxFeeCap) {
    if (!cfg.sniperBypassFeeCap) {
      throw new Error(
        `maxFee ${ethers.formatUnits(maxFee, "gwei")}gw > MAX_FEE_GWEI=${cfg.maxFeeGwei}. ` +
          `Set SNIPER_BYPASS_FEE_CAP=true kalau Anda mau yolo (HATI-HATI).`
      );
    }
    bypassWarning =
      `BYPASS aktif: maxFee ${ethers.formatUnits(maxFee, "gwei")}gw ` +
      `melebihi cap ${cfg.maxFeeGwei}gw. ` +
      `Estimasi biaya: ${ethers.formatEther(BigInt(cfg.staticGasLimit) * maxFee)} ETH`;
  }
  return { maxFee, tip, bypassWarning };
}

/**
 * Validasi cepat sebuah extra RPC: cek chainId == 1.
 * RPC yang chainId-nya salah dilempar dan diabaikan.
 */
async function validateExtraRpc(url) {
  const p = new ethers.JsonRpcProvider(url);
  const net = await p.getNetwork();
  if (net.chainId !== ETHEREUM_CHAIN_ID) {
    throw new Error(
      `RPC ${url} bukan mainnet (chainId=${net.chainId.toString()}); diabaikan`
    );
  }
  return p;
}

/**
 * Pre-flight: lakukan SEKALI sebelum mint window.
 * Validasi mahal, resolve ENS, build ABI, encode calldata,
 * cache nonce & baseFee, optional pre-sign tx.
 */
async function preflight(cfg) {
  const t0 = Date.now();
  const log = (msg) => console.log(`[preflight +${Date.now() - t0}ms]`, msg);

  // Provider utama + wallet (chainId guard di sini)
  const { provider, wallet } = await buildProviderAndWallet(cfg);
  log(`wallet ${wallet.address}`);

  // Provider tambahan untuk parallel broadcast — chainId di-validate paralel
  const extraResults = await Promise.allSettled(
    cfg.extraRpcUrls.map((url) => validateExtraRpc(url))
  );
  const extraProviders = [];
  for (let i = 0; i < extraResults.length; i++) {
    const r = extraResults[i];
    const url = cfg.extraRpcUrls[i];
    if (r.status === "fulfilled") {
      extraProviders.push(r.value);
    } else {
      console.warn(`[preflight] skip extra RPC ${url}: ${r.reason?.message || r.reason}`);
    }
  }
  const broadcastProviders = [provider, ...extraProviders];
  log(`broadcast providers: ${broadcastProviders.length} (1 primary + ${extraProviders.length} extra valid)`);

  // Resolve target + bytecode + ABI fragment + denylist
  const target = await loadTarget(provider, cfg.nftContract, cfg.mintFn, {
    allowDangerousFn: cfg.allowDangerousFn,
  });
  const args = buildArgs(cfg.mintArgs, target.fragment, wallet.address);
  log(`target ${target.address} fn=${target.fragment.name}`);

  // Encode calldata sekali — tidak akan berubah di hot path
  const data = target.iface.encodeFunctionData(target.fragment, args);
  const value =
    ethers.parseEther(String(cfg.mintPriceEth)) * BigInt(cfg.quantity);
  log(
    `calldata ready (${(data.length - 2) / 2} bytes)  value=${ethers.formatEther(value)} ETH`
  );

  // Pre-fetch nonce, baseFee, balance paralel
  const [nonce, block, balance] = await Promise.all([
    provider.getTransactionCount(wallet.address, "pending"),
    provider.getBlock("latest"),
    provider.getBalance(wallet.address),
  ]);
  if (!block || block.baseFeePerGas == null) {
    throw new Error("Block terbaru tidak punya baseFeePerGas. Apakah benar Ethereum?");
  }
  log(
    `nonce=${nonce}  baseFee=${ethers.formatUnits(block.baseFeePerGas, "gwei")} gwei  ` +
      `balance=${ethers.formatEther(balance)} ETH`
  );

  // Estimasi kasar biaya minimum (gas + value) untuk peringatan saldo
  const minMaxFee = block.baseFeePerGas * 3n + ethers.parseUnits(String(cfg.sniperPriorityGwei), "gwei");
  const minNeeded = BigInt(cfg.staticGasLimit) * minMaxFee + value;
  if (balance < minNeeded) {
    console.warn(
      `[preflight] PERINGATAN: saldo wallet (${ethers.formatEther(balance)} ETH) ` +
        `mungkin kurang dari estimasi minimum (${ethers.formatEther(minNeeded)} ETH = gas + value). ` +
        `Tx bisa revert "insufficient funds" saat trigger fire.`
    );
  }

  // Build trigger detector untuk mode poll
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

  // Optional pre-sign tx — biggest hot path optimization
  let preSignedTx = null;
  if (cfg.preSignTx) {
    const { maxFee, tip, bypassWarning } = computeFees(
      block.baseFeePerGas,
      cfg,
      cfg.preSignFeeMultiplier
    );
    if (bypassWarning) console.warn(`[preflight] !! ${bypassWarning}`);

    const tSign = Date.now();
    preSignedTx = await wallet.signTransaction({
      to: target.address,
      data,
      value,
      gasLimit: BigInt(cfg.staticGasLimit),
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: tip,
      chainId: 1,
      type: 2,
      nonce,
    });
    log(
      `pre-signed tx (${Date.now() - tSign}ms)  ` +
        `maxFee=${ethers.formatUnits(maxFee, "gwei")}gw  ` +
        `tip=${ethers.formatUnits(tip, "gwei")}gw  ` +
        `nonce=${nonce} (FROZEN)`
    );
  }

  return {
    wallet,
    provider,
    broadcastProviders,
    target,
    data,
    value,
    triggerIface,
    triggerView,
    triggerCallData,
    preSignedTx,
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
    let firstErrorLogged = false;
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
        if (!firstErrorLogged) {
          firstErrorLogged = true;
          console.warn(
            `\n[trigger] poll error (akan terus retry): ${err.shortMessage || err.message}\n` +
              `         pastikan TRIGGER_FN cocok dengan ABI kontrak target.`
          );
        }
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
 * Fetch nonce + baseFee dengan fault tolerance: race antar broadcast providers.
 * First success wins. Kalau semua gagal, throw.
 */
async function fetchHotPathState(broadcastProviders, walletAddress) {
  const tasks = broadcastProviders.map(async (p) => {
    const [nonce, block] = await Promise.all([
      p.getTransactionCount(walletAddress, "pending"),
      p.getBlock("latest"),
    ]);
    if (!block || block.baseFeePerGas == null) {
      throw new Error("block tidak punya baseFeePerGas");
    }
    return { nonce, baseFee: block.baseFeePerGas };
  });
  return Promise.any(tasks);
}

/**
 * Hot path — dijalankan TEPAT saat trigger menyala.
 *
 * Dua jalur:
 *   A. Pre-signed (cfg.preSignTx=true): broadcast cached signed tx langsung.
 *      Latensi minimum: ~50ms (cuma broadcast roundtrip).
 *   B. Live-sign: refresh nonce+baseFee → sign → broadcast.
 *      Latensi: ~80-150ms.
 */
async function hotPath(ctx) {
  const { wallet, broadcastProviders, target, data, value, cfg, preSignedTx } = ctx;
  const t0 = Date.now();

  let signedTx;
  if (preSignedTx) {
    signedTx = preSignedTx;
    console.log(
      `[hot +${Date.now() - t0}ms] pakai pre-signed tx (skip nonce+baseFee+sign)`
    );
  } else {
    let state;
    try {
      state = await fetchHotPathState(broadcastProviders, wallet.address);
    } catch (aggErr) {
      throw new Error(
        `Gagal fetch nonce/baseFee dari semua RPC. ` +
          `(${aggErr.errors?.[0]?.message || aggErr.message})`
      );
    }
    const { nonce: freshNonce, baseFee } = state;
    console.log(
      `[hot +${Date.now() - t0}ms] nonce=${freshNonce} baseFee=${ethers.formatUnits(baseFee, "gwei")}gw`
    );

    const { maxFee, tip, bypassWarning } = computeFees(baseFee, cfg, 3);
    if (bypassWarning) console.warn(`[sniper] !! ${bypassWarning}`);

    const tSign = Date.now();
    signedTx = await wallet.signTransaction({
      to: target.address,
      data,
      value,
      gasLimit: BigInt(cfg.staticGasLimit),
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: tip,
      chainId: 1,
      type: 2,
      nonce: freshNonce,
    });
    console.log(`[hot +${Date.now() - t0}ms] signed (${Date.now() - tSign}ms)`);
  }

  // Parallel broadcast dengan first-success race
  const t2 = Date.now();
  const sendPromises = broadcastProviders.map((p, i) =>
    p
      .broadcastTransaction(signedTx)
      .then((res) => ({ idx: i, hash: res.hash, ms: Date.now() - t2 }))
  );

  let accepted;
  try {
    accepted = await Promise.any(sendPromises);
  } catch (aggErr) {
    const firstErr = aggErr.errors?.[0];
    const msg = firstErr?.shortMessage || firstErr?.message || "unknown";
    throw new Error(`Semua ${broadcastProviders.length} RPC menolak tx. First error: ${msg}`);
  }

  console.log(
    `[hot +${Date.now() - t0}ms] tx accepted by RPC[${accepted.idx}] in ${accepted.ms}ms: ${accepted.hash}`
  );
  console.log(`etherscan: https://etherscan.io/tx/${accepted.hash}`);
  console.log("[done] fire-and-forget — cek tx di Etherscan untuk konfirmasi akhir");

  return { hash: accepted.hash };
}

export async function runSniper(cfg) {
  console.log("=== ACO Sniper (Ethereum Mainnet) ===");
  console.log(
    `mode=${cfg.triggerMode}  static-gas=${cfg.staticGasLimit}  ` +
      `pre-sign=${cfg.preSignTx}  bypass-fee-cap=${cfg.sniperBypassFeeCap}`
  );

  const ctx = await preflight(cfg);
  console.log("--- pre-flight selesai, tunggu trigger ---\n");

  await waitForTrigger(ctx);
  console.log("\n--- TRIGGER FIRE — masuk hot path ---");

  return hotPath(ctx);
}
