# ACO Sniper

**Instant mint execution** untuk kontrak NFT di **Ethereum Mainnet**. Fokus tunggal: latensi serendah mungkin saat mint window live, dengan tetap mempertahankan minimum safety yang tidak menambah hot path overhead.

> **Khusus Ethereum Mainnet (chainId = 1).** Skrip ini menolak chain lain.

> Tujuan utama: **execution speed, low latency, transaction inclusion, successful mint completion.** Tidak ada simulasi, prompt, atau dry-run.

---

## Daftar Isi

- [Filosofi](#filosofi)
- [Persyaratan](#persyaratan)
- [Instalasi](#instalasi)
- [Konfigurasi](#konfigurasi)
- [Penggunaan](#penggunaan)
- [Trigger Modes](#trigger-modes)
- [Hot Path Optimization](#hot-path-optimization)
- [Safety Rails (zero hot-path overhead)](#safety-rails-zero-hot-path-overhead)
- [Pemecahan Masalah](#pemecahan-masalah)
- [Lisensi](#lisensi)

## Filosofi

```
┌─────── PRE-FLIGHT (sebelum mint window, latency tidak penting) ───────┐
│  1. Validasi chain == 1                                                │
│  2. Verifikasi bytecode kontrak                                        │
│  3. Resolve ENS (optional)                                             │
│  4. Build ABI minimal + dangerous fn denylist                          │
│  5. Encode calldata                                                    │
│  6. Validate extra RPCs (chainId per-RPC)                              │
│  7. Cache nonce + baseFee + balance (paralel)                          │
│  8. (Optional) Pre-sign tx                                             │
└────────────────────────────────────────────────────────────────────────┘
                              ↓
                       (tunggu trigger)
                              ↓
┌─────── HOT PATH (saat trigger fire) ──────────────────────────────────┐
│  Pre-sign mode (PRESIGN_TX=true):                                      │
│    broadcast cached_signed_tx → DONE (~50ms)                           │
│                                                                        │
│  Live-sign mode (PRESIGN_TX=false):                                    │
│    fetch nonce/baseFee race → sign → broadcast → DONE (~80-150ms)      │
│                                                                        │
│  Multi-RPC parallel broadcast dengan Promise.any first-success race.   │
│  Fire-and-forget: return setelah hash; cek Etherscan untuk konfirmasi. │
└────────────────────────────────────────────────────────────────────────┘
```

## Persyaratan

- **Node.js** 18+
- **RPC Ethereum Mainnet** (Alchemy / Infura / Flashbots Protect / node pribadi)
- **Burner wallet** dengan saldo cukup untuk `mint price + biaya gas`

> **WAJIB:** burner wallet dedicated. Kalau ada tx lain dari wallet ini antara pre-flight dan trigger fire, sniper akan gagal (terutama di mode `PRESIGN_TX=true` karena nonce di-freeze).

## Instalasi

```bash
git clone https://github.com/Khaerlwww/ACO.git
cd ACO
npm install
cp .env.example .env
# edit .env
```

## Konfigurasi

### Wajib

| Variabel | Deskripsi |
| --- | --- |
| `RPC_URL` | RPC Ethereum Mainnet primary |
| `PRIVATE_KEY` | Private key burner wallet |
| `NFT_CONTRACT` | Alamat `0x...` atau ENS (mis. `azuki.eth`) |
| `MINT_FN` | Tanda tangan fungsi mint (mis. `mint(uint256)`) |
| `MINT_ARGS` | Argumen koma. `{WALLET}` = alamat burner |

### Opsional

| Variabel | Default | Deskripsi |
| --- | --- | --- |
| `MINT_PRICE_ETH` | `0` | Harga per token |
| `QUANTITY` | `1` | Jumlah token |
| `ALLOW_DANGEROUS_FN` | `false` | Izinkan MINT_FN seperti `approve` (HATI-HATI) |
| `TRIGGER_MODE` | `immediate` | `immediate` / `poll` / `timestamp` / `block` |
| `TRIGGER_FN` | — | View fn untuk mode poll (mis. `mintActive() returns (bool)`) |
| `TRIGGER_EXPECT` | `true` | Nilai yang trigger fire |
| `POLL_MS` | `200` | Interval poll (ms) |
| `TRIGGER_TIMESTAMP` | `0` | Unix epoch detik untuk mode timestamp |
| `TRIGGER_BLOCK` | `0` | Block number untuk mode block |
| `EXTRA_RPC_URLS` | — | RPC tambahan (comma-separated) untuk parallel broadcast |
| `STATIC_GAS_LIMIT` | `300000` | Gas limit statik (skip estimateGas) |
| `MAX_FEE_GWEI` | `20` | Hard cap maxFeePerGas |
| `SNIPER_PRIORITY_GWEI` | `3` | Priority fee untuk inclusion cepat |
| `SNIPER_BYPASS_FEE_CAP` | `false` | Bypass `MAX_FEE_GWEI` (yolo) |
| `PRESIGN_TX` | `false` | Pre-sign tx di pre-flight (~50-100ms saving) |
| `PRESIGN_FEE_MULTIPLIER` | `5` | baseFee multiplier untuk pre-signed maxFee |

## Penggunaan

```bash
npm start
# atau
node src/index.js

# Bantuan
node src/index.js --help
```

## Trigger Modes

| Mode | Perilaku | Use case |
| --- | --- | --- |
| `immediate` | Fire langsung saat skrip dijalankan | Mint sudah live, eksekusi sekarang |
| `poll` | Poll view fn sampai cocok `TRIGGER_EXPECT` | Tunggu `mintActive() == true` |
| `timestamp` | Tunggu Unix timestamp | Mint scheduled jam X |
| `block` | Tunggu block number | Mint live di block X |

### Contoh: poll `mintActive()`

```env
TRIGGER_MODE=poll
TRIGGER_FN=mintActive() returns (bool)
TRIGGER_EXPECT=true
POLL_MS=150
```

### Contoh: scheduled mint

```env
TRIGGER_MODE=timestamp
TRIGGER_TIMESTAMP=1735689600
PRESIGN_TX=true
PRESIGN_FEE_MULTIPLIER=8
```

## Hot Path Optimization

### Multi-RPC Parallel Broadcast

```env
EXTRA_RPC_URLS=https://eth.llamarpc.com,https://rpc.ankr.com/eth
```

Tx dikirim ke `RPC_URL` + semua extra paralel. `Promise.any` race untuk first-success → return hash secepat ada satu RPC accept.

### Pre-Signed Tx

```env
PRESIGN_TX=true
PRESIGN_FEE_MULTIPLIER=5
```

Sign tx **di pre-flight**. Hot path tinggal broadcast. Saving ~50-100ms karena skip nonce/baseFee fetch + sign.

**Trade-off:**
- Nonce di-FREEZE. Pastikan burner wallet tidak ada tx lain.
- maxFee pakai multiplier headroom (default 5×) untuk survive gas spike.

### Static Gas Limit

```env
STATIC_GAS_LIMIT=300000
```

Skip `estimateGas` (~50-100ms saving). Nilai 300_000 cukup untuk mayoritas mint sederhana; sesuaikan dengan target Anda (cek tx mint sebelumnya di Etherscan).

### Aggressive Fee

```
maxFee = (baseFee × 3) + tip       (live-sign)
maxFee = (baseFee × 5) + tip       (pre-sign, default headroom)
```

Tip default 3 gwei untuk inclusion cepat di blok awal.

## Safety Rails (zero hot-path overhead)

Semua dilakukan **sekali di pre-flight**, tidak menambah latensi hot path:

| Rail | Mencegah |
|---|---|
| Chain ID = 1 dipaku | Tx di-broadcast ke chain salah |
| Bytecode existence check | Alamat kontrak salah / belum deploy |
| Dangerous function denylist | `MINT_FN=approve` typo yang bisa drain wallet |
| Fee cap `MAX_FEE_GWEI` | RPC kasih baseFee absurd → drain wallet |
| Extra RPC chainId validation | Salah satu RPC ke chain lain → wasted tx |
| Format validation (private key, address, dst.) | Typo di `.env` lolos sampai runtime |

## Pemecahan Masalah

| Pesan error | Penyebab | Solusi |
| --- | --- | --- |
| `RPC bukan Ethereum Mainnet` | RPC ke L2/testnet | Ganti `RPC_URL` ke endpoint mainnet |
| `PRIVATE_KEY format tidak valid` | Placeholder belum diganti | Isi private key burner real |
| `Tidak ada bytecode di ...` | Alamat kontrak salah | Verifikasi di Etherscan |
| `MINT_FN ... berpotensi berbahaya` | `MINT_FN` adalah fungsi non-mint (approve, dst.) | Pastikan benar; kalau perlu set `ALLOW_DANGEROUS_FN=true` |
| `maxFee ... > MAX_FEE_GWEI` | Gas mainnet tinggi atau bypass tidak diaktifkan | Naikkan `MAX_FEE_GWEI` atau `SNIPER_BYPASS_FEE_CAP=true` |
| `Saldo wallet ... mungkin kurang` | Burner wallet kurang ETH | Top up sebelum mint window |
| `TRIGGER_MODE=... tidak valid` | Typo | Pilih `immediate`/`poll`/`timestamp`/`block` |
| `Semua N RPC menolak tx` | Network issue atau tx invalid | Cek error message; verifikasi RPC bekerja |

## Lisensi

[MIT](./LICENSE)
