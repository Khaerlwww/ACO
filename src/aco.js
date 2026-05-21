import { ethers } from "ethers";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { buildProviderAndWallet } from "./provider.js";
import { loadTarget, buildArgs } from "./contract.js";
import { simulate, buildEthereumFees, enforceTotalCostCap } from "./simulate.js";

// Hanya error transien yang AMAN untuk retry (tidak menandakan tx kita sudah mined).
// "nonce too low" SENGAJA TIDAK di sini: itu sinyal tx sebelumnya sudah masuk
// dan retry-nya bisa menyebabkan double-mint kalau nonce di-refresh.
const TRANSIENT = [
  "could not coalesce",
  "blockhash",
  "timeout",
  "etimedout",
  "econnreset",
  "server response 5",
  "rate limit",
];

function isTransient(err) {
  const msg = (err?.shortMessage || err?.message || "").toLowerCase();
  return TRANSIENT.some((t) => msg.includes(t));
}

async function confirm(question) {
  const rl = readline.createInterface({ input, output });
  try {
    const ans = (await rl.question(question)).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

function fmtGwei(v) {
  return ethers.formatUnits(v ?? 0n, "gwei");
}

/**
 * Daftar query parameter yang umum berisi API key/token; harus disensor.
 */
const SENSITIVE_QUERY_KEYS = new Set([
  "key",
  "apikey",
  "api_key",
  "api-key",
  "token",
  "auth",
  "secret",
  "access_token",
  "accesstoken",
  "password",
]);

/**
 * Sensor RPC URL untuk logging:
 *   1. Hapus basic auth (`user:pass@host`)
 *   2. Sensor segmen path terakhir kalau panjang (≥16 char) — pola Alchemy/Infura
 *   3. Sensor query param yang nama key-nya umum dipakai untuk credential
 *
 * Host & path publik tetap terlihat untuk debugging.
 */
function redactRpc(url) {
  try {
    const u = new URL(url);

    // 1. Strip basic auth credentials
    if (u.username || u.password) {
      u.username = "<redacted>";
      u.password = "";
    }

    // 2. Redact path segment terakhir kalau panjang (kemungkinan API key)
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length > 0 && segs[segs.length - 1].length >= 16) {
      segs[segs.length - 1] = "<redacted>";
      u.pathname = "/" + segs.join("/");
    }

    // 3. Redact sensitive query parameters
    for (const k of Array.from(u.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.has(k.toLowerCase())) {
        u.searchParams.set(k, "<redacted>");
      }
    }

    return u.toString();
  } catch {
    return url;
  }
}

export async function runAco(cfg, { send }) {
  const { provider, wallet } = await buildProviderAndWallet(cfg);
  const target = await loadTarget(provider, cfg.nftContract, cfg.mintFn, {
    allowDangerousFn: cfg.allowDangerousFn,
  });
  const args = buildArgs(cfg.mintArgs, target.fragment, wallet.address);

  const value =
    ethers.parseEther(String(cfg.mintPriceEth)) * BigInt(cfg.quantity);

  console.log("=== ACO NFT (Ethereum Mainnet) ===");
  console.log("rpc        :", redactRpc(cfg.rpcUrl));
  console.log(
    "mev shield :",
    cfg.usingFlashbotsProtect ? "Flashbots Protect (aktif)" : "publik (rentan MEV)"
  );
  console.log("wallet     :", wallet.address);
  console.log(
    "balance    :",
    ethers.formatEther(await provider.getBalance(wallet.address)),
    "ETH"
  );
  console.log("contract   :", target.address, `(${target.codeSize} bytes)`);
  console.log("etherscan  :", target.etherscanContract);
  console.log("function   :", target.fragment.format("full"));
  console.log("args       :", args.map(String));
  console.log("msg.value  :", ethers.formatEther(value), "ETH");

  const sim = await simulate({ provider, wallet, target, args, value });
  console.log("calldata   :", sim.data);
  console.log("gasLimit   :", sim.gasLimit.toString());

  const fees = await buildEthereumFees(provider, cfg);
  console.log("fee source :", fees.feeSource);
  console.log(
    "baseFee    :",
    fmtGwei(fees.baseFee),
    "gwei  tip:",
    fmtGwei(fees.tipFromSource),
    "gwei"
  );
  console.log(
    "fee plan   : maxFee",
    fmtGwei(fees.maxFeePerGas),
    "gwei  prio",
    fmtGwei(fees.maxPriorityFeePerGas),
    "gwei"
  );

  const cost = enforceTotalCostCap({ fees, gasLimit: sim.gasLimit, value, cfg });
  console.log(
    "est. cost  :",
    ethers.formatEther(cost.totalCost) +
      " ETH (gas " +
      ethers.formatEther(cost.gasCost) +
      " + value " +
      ethers.formatEther(value) +
      ")"
  );

  // Cek saldo cukup sebelum tanya konfirmasi
  const balance = await provider.getBalance(wallet.address);
  if (balance < cost.totalCost) {
    throw new Error(
      `Saldo wallet (${ethers.formatEther(balance)} ETH) kurang dari ` +
        `estimasi total biaya (${ethers.formatEther(cost.totalCost)} ETH). ` +
        `Tambah ETH ke ${wallet.address}.`
    );
  }

  if (!send) {
    console.log("\n[dry-run] simulasi sukses. Jalankan ulang dengan --send untuk broadcast.");
    return { dryRun: true };
  }

  // Gerbang ekstra di luar --send: cegah broadcast tidak sengaja.
  // User wajib eksplisit set LIVE_MINT_APPROVED=yes di .env.
  if (!cfg.liveMintApproved) {
    throw new Error(
      "Broadcast diblokir oleh hardening gate. " +
        "Untuk mengirim transaksi, set LIVE_MINT_APPROVED=yes di .env DAN gunakan --send. " +
        "Ini lapisan kedua di atas konfirmasi y/N untuk mencegah eksekusi tidak sengaja."
    );
  }

  const ok = await confirm(
    `\nKirim transaksi sekarang? Burner=${wallet.address}, ` +
      `value=${ethers.formatEther(value)} ETH, ` +
      `est=${ethers.formatEther(cost.totalCost)} ETH. [y/N] `
  );
  if (!ok) {
    console.log("Dibatalkan oleh pengguna.");
    return { aborted: true };
  }

  // Pakai pending nonce eksplisit supaya tidak macet di nonce lama
  const nonce = await provider.getTransactionCount(wallet.address, "pending");

  const txReq = {
    to: target.address,
    data: sim.data,
    value,
    gasLimit: (sim.gasLimit * 12n) / 10n, // headroom 20%
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    chainId: 1,
    type: 2,
    nonce,
  };

  let lastErr;
  for (let attempt = 1; attempt <= cfg.maxRetries; attempt++) {
    try {
      console.log(`\nattempt ${attempt}/${cfg.maxRetries}: mengirim...`);
      const sent = await wallet.sendTransaction(txReq);
      console.log("tx hash    :", sent.hash);
      console.log("etherscan  : https://etherscan.io/tx/" + sent.hash);
      console.log(
        `menunggu ${cfg.confirmations} konfirmasi...`
      );
      const rc = await sent.wait(cfg.confirmations);
      if (!rc) {
        throw new Error(
          "Transaksi tidak pernah mendapat konfirmasi (kemungkinan di-drop dari mempool). " +
            "Cek manual di Etherscan; jangan retry buta."
        );
      }
      console.log("status     :", rc.status === 1 ? "SUKSES" : "GAGAL");
      console.log("block      :", rc.blockNumber);
      console.log("gasUsed    :", rc.gasUsed.toString());
      console.log(
        "biaya nyata:",
        ethers.formatEther(rc.gasUsed * (rc.gasPrice ?? fees.maxFeePerGas)),
        "ETH"
      );
      return { hash: sent.hash, receipt: rc };
    } catch (err) {
      lastErr = err;
      console.log("error      :", err.shortMessage || err.message);
      if (!isTransient(err) || attempt === cfg.maxRetries) break;
      await new Promise((r) => setTimeout(r, cfg.retryDelayMs));
    }
  }
  throw lastErr;
}
