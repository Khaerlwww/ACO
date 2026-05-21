import { ethers } from "ethers";

/**
 * Resolusi alamat target. Mendukung dua bentuk input:
 *   - Alamat checksum/lowercase (`0x...`)
 *   - Nama ENS (`azuki.eth`, dll.)
 *
 * Resolusi ENS hanya berjalan di Ethereum Mainnet, yang memang
 * satu-satunya chain yang didukung skrip ini.
 */
async function resolveAddress(provider, input) {
  const trimmed = input.trim();
  if (ethers.isAddress(trimmed)) return ethers.getAddress(trimmed);

  if (trimmed.includes(".")) {
    const resolved = await provider.resolveName(trimmed);
    if (!resolved) {
      throw new Error(`Nama ENS tidak bisa diresolusi: ${trimmed}`);
    }
    return ethers.getAddress(resolved);
  }

  throw new Error(`NFT_CONTRACT bukan alamat valid atau nama ENS: ${input}`);
}

/**
 * Memverifikasi bahwa alamat target benar-benar memiliki bytecode,
 * lalu membangun Interface ethers dari satu fungsi mint yang ditulis
 * pengguna. ABI minimal ini dipakai untuk mencegah skrip memanggil
 * fungsi lain di luar yang diinginkan.
 */
export async function loadTarget(provider, addressOrEns, mintFnSig) {
  const address = await resolveAddress(provider, addressOrEns);

  const code = await provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error(
      `Tidak ada bytecode di ${address} pada Ethereum Mainnet. ` +
        `Periksa kembali alamat kontrak.`
    );
  }

  // Bangun signature lengkap. Kalau user belum kasih state mutability
  // (view/pure/payable/nonpayable), tambahkan `payable` agar ethers
  // tidak rewel saat encode tx dengan msg.value > 0.
  const sig = mintFnSig.trim();
  const hasMutability = /\b(view|pure|payable|nonpayable)\b/.test(sig);
  const hasPrefix = sig.startsWith("function ");
  const fragSrc = hasPrefix
    ? sig
    : `function ${sig}${hasMutability ? "" : " payable"}`;

  let iface, fragment;
  try {
    iface = new ethers.Interface([fragSrc]);
    fragment = iface.fragments[0];
  } catch (err) {
    throw new Error(
      `MINT_FN tidak bisa diparse: "${mintFnSig}". ` +
        `Detail: ${err.shortMessage || err.message}`
    );
  }
  if (!fragment || fragment.type !== "function") {
    throw new Error(`MINT_FN harus berupa fungsi, dapat: ${fragment?.type}`);
  }

  return {
    address,
    iface,
    fragment,
    codeSize: (code.length - 2) / 2,
    etherscanContract: `https://etherscan.io/address/${address}`,
  };
}

/**
 * Mengonversi argumen string dari .env menjadi tipe yang diharapkan
 * ethers (uint -> bigint, address -> string, bool -> bool). Placeholder
 * `{WALLET}` diganti dengan alamat dompet pengirim.
 */
export function buildArgs(rawArgs, fragment, walletAddress) {
  if (rawArgs.length !== fragment.inputs.length) {
    throw new Error(
      `Jumlah argumen tidak cocok: ${fragment.name} membutuhkan ` +
        `${fragment.inputs.length}, diberi ${rawArgs.length}. ` +
        `Catatan: tuple/array tidak didukung di MINT_ARGS karena split koma.`
    );
  }
  return rawArgs.map((a, i) => {
    const t = fragment.inputs[i].type;
    const v = a === "{WALLET}" ? walletAddress : a;

    if (t.startsWith("uint") || t.startsWith("int")) {
      try {
        return BigInt(v);
      } catch {
        throw new Error(
          `Argumen ke-${i + 1} (${fragment.inputs[i].name || t}) ` +
            `bukan integer valid: "${v}". Gunakan bilangan bulat tanpa desimal.`
        );
      }
    }

    if (t === "bool") {
      const s = String(v).toLowerCase();
      if (["true", "1", "yes", "y"].includes(s)) return true;
      if (["false", "0", "no", "n"].includes(s)) return false;
      throw new Error(`Argumen ke-${i + 1} (bool) tidak valid: "${v}"`);
    }

    if (t === "address") {
      if (!ethers.isAddress(v)) {
        throw new Error(`Argumen ke-${i + 1} (address) tidak valid: "${v}"`);
      }
      return ethers.getAddress(v);
    }

    return v;
  });
}
