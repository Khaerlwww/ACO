import { ethers } from "ethers";
import { ETHEREUM_CHAIN_ID } from "./config.js";

/**
 * Membangun provider + wallet, lalu memaksakan bahwa RPC benar-benar
 * berbicara dengan Ethereum Mainnet (chainId 1). Skrip ini sengaja
 * tidak mendukung chain lain.
 *
 * Catatan: kami sengaja TIDAK mengoper static network ke constructor
 * `JsonRpcProvider`. Membiarkan provider melakukan auto-detect via
 * `getNetwork()` membuat dukungan ENS aktif (provider menarik ENS
 * registry address dari built-in mainnet network metadata di ethers v6).
 */
export async function buildProviderAndWallet(cfg) {
  // Validasi format private key sebelum sentuh jaringan
  if (!/^0x[0-9a-fA-F]{64}$/.test(cfg.privateKey)) {
    throw new Error(
      "PRIVATE_KEY format tidak valid. Harus 0x + 64 karakter hex. " +
        "Apakah Anda lupa mengganti placeholder di .env?"
    );
  }

  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);

  let network;
  try {
    network = await provider.getNetwork();
  } catch (err) {
    throw new Error(
      `Tidak bisa terhubung ke RPC. ` +
        `Detail: ${err.shortMessage || err.message}`
    );
  }

  if (network.chainId !== ETHEREUM_CHAIN_ID) {
    throw new Error(
      `RPC bukan Ethereum Mainnet. Diharapkan chainId=1, dapat chainId=${network.chainId.toString()}. ` +
        `Skrip ini hanya untuk Ethereum.`
    );
  }

  const wallet = new ethers.Wallet(cfg.privateKey, provider);
  return { provider, wallet, network };
}
