import { ethers } from "ethers";

import { buildProviderAndWallet } from "./provider.js";
import { loadTarget, buildArgs } from "./contract.js";
import { ETHEREUM_CHAIN_ID } from "./config.js";

/**
 * Sniper mode — instant mint execution dengan latensi minimum.
 *
 * Filosofi:
 *   - Semua validasi mahal dilakukan SEKALI di pre-flight, sebelum mint window
 *   - Hot path (saat mint live): nonce -> gas -> sign -> parallel broadcast
 *   - Tidak ada simulasi, prompt, atau dry-run di sini
 *   - Multi-RPC parallel broadcast dengan first-success race (Promise.any)
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
 * Dipakai oleh hot path & pre-sign.
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
 * Dipanggil paralel di pre-flight; RPC yang chainId-nya salah dilempar.
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

  // 2. Provider tambahan untuk parallel broadcast
  //    Validasi paralel: setiap extra RPC dicek chainId-nya sebelum dipakai.
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

  // 5. Pre-fetch nonce, baseFee, balance paralel.
  //    Balance untuk peringatan saja (tidak block) — sniper sengaja tidak gating saldo.
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
        `Tx bisa revert "insufficient funds" saat trigger fire. Top up wallet sebelum mint window.`
    );
  }

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

  // 7. (Opsional) Pre-sign tx — biggest hot path optimization.
  //    Trade-off: nonce di-freeze, maxFee pakai multiplier headroom besar.
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
    initialNonce: nonce,
    initialBaseFee: block.baseFeePerGas,
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
        // Log full error pertama kali untuk debugging (mis. fungsi tidak ada di kontrak)
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
 * Fetch nonce + baseFee dengan fault tolerance: race antara primary
 * dan extra providers. First success wins. Kalau semua gagal, throw.
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
    return { nonce, baseFee: block.baseFeePerGas, source: p };
  });
  // Promise.any: first fulfilled, ignore rejections
  return Promise.any(tasks);
}

/**
 * Hot path — dijalankan TEPAT saat trigger menyala.
 * Tidak ada simulasi, tidak ada prompt.
 *
 * Dua jalur:
 *   A. Pre-signed (cfg.preSignTx=true): broadcast cached signed tx langsung.
 *      Latensi minimum: ~50ms (cuma broadcast roundtrip).
 *   B. Live-sign: refresh nonce+baseFee → sign → broadcast.
 *      Latensi: ~100-150ms.
 */
async function hotPath(ctx) {
  const { wallet, broadcastProviders, target, data, value, cfg, preSignedTx } = ctx;
  const t0 = Date.now();

  let signedTx;
  if (preSignedTx) {
    // JALUR A: tx sudah di-sign di pre-flight, langsung broadcast
    signedTx = preSignedTx;
    console.log(
      `[hot +${Date.now() - t0}ms] pakai pre-signed tx (skip nonce+baseFee+sign, ~50-100ms saving)`
    );
  } else {
    // JALUR B: live-sign

    // Fault-tolerant fetch nonce & baseFee — race antar broadcast providers
    let state;
    try {
      state = await fetchHotPathState(broadcastProviders, wallet.address);
    } catch (aggErr) {
      throw new Error(
        `Gagal fetch nonce/baseFee dari semua RPC. ` +
          `Cek koneksi & EXTRA_RPC_URLS. (${aggErr.errors?.[0]?.message || aggErr.message})`
      );
    }
    const { nonce: freshNonce, baseFee } = state;
    console.log(
      `[hot +${Date.now() - t0}ms] nonce=${freshNonce} baseFee=${ethers.formatUnits(baseFee, "gwei")}gw`
    );

    const { maxFee, tip, bypassWarning } = computeFees(baseFee, cfg, 3);
    if (bypassWarning) console.warn(`[sniper] !! ${bypassWarning}`);

    const txReq = {
      to: target.address,
      data,
      value,
      gasLimit: BigInt(cfg.staticGasLimit),
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: tip,
      chainId: 1,
      type: 2,
      nonce: freshNonce,
    };

    const tSign = Date.now();
    signedTx = await wallet.signTransaction(txReq);
    console.log(`[hot +${Date.now() - t0}ms] signed (${Date.now() - tSign}ms)`);
  }

  // Parallel broadcast ke semua RPC dengan FIRST-SUCCESS race.
  // Promise.any return begitu ada satu yang accept; sisanya tetap jalan
  // di background tapi kita tidak menunggu mereka.
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
    // Semua reject → AggregateError. Ambil pesan dari yang pertama untuk debugging.
    const firstErr = aggErr.errors?.[0];
    const msg = firstErr?.shortMessage || firstErr?.message || "unknown";
    throw new Error(`Semua ${broadcastProviders.length} RPC menolak tx. First error: ${msg}`);
  }

  console.log(
    `[hot +${Date.now() - t0}ms] tx accepted by RPC[${accepted.idx}] in ${accepted.ms}ms: ${accepted.hash}`
  );
  console.log(`etherscan: https://etherscan.io/tx/${accepted.hash}`);

  // Background: log hasil RPC lain untuk audit (tidak menunggu)
  Promise.allSettled(sendPromises).then((all) => {
    for (let i = 0; i < all.length; i++) {
      const r = all[i];
      if (i === accepted.idx) continue; // sudah dilaporkan
      if (r.status === "fulfilled") {
        console.log(`  RPC[${i}] also OK ${r.value.ms}ms hash=${r.value.hash}`);
      } else {
        const err = r.reason;
        console.log(
          `  RPC[${i}] FAIL ${err?.shortMessage || err?.message || "unknown"}`
        );
      }
    }
  });

  if (cfg.waitForConfirmation) {
    console.log(`[wait] menunggu konfirmasi blok...`);
    const rc = await ctx.provider.waitForTransaction(accepted.hash, 1);
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
    `mode=${cfg.triggerMode}  static-gas=${cfg.staticGasLimit}  ` +
      `pre-sign=${cfg.preSignTx}  bypass-fee-cap=${cfg.sniperBypassFeeCap}`
  );

  const ctx = await preflight(cfg);
  console.log("--- pre-flight selesai, tunggu trigger ---\n");

  await waitForTrigger(ctx);
  console.log("\n--- TRIGGER FIRE — masuk hot path ---");

  return hotPath(ctx);
}
