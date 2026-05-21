# ACO

**Auto Checkout / Auto Mint** untuk kontrak NFT di **Ethereum Mainnet**, dengan prinsip _safe-by-default_. Dibangun di atas Node.js dan [ethers v6](https://docs.ethers.org/v6/).

> **Khusus Ethereum Mainnet (chainId = 1).** Skrip ini sengaja menolak chain lain (testnet, Base, Arbitrum, dst.) untuk menghindari kesalahan konfigurasi yang tidak bisa diperbaiki setelah broadcast.

> Tujuan utama: membantu mint NFT secara cepat **tanpa** mengorbankan keamanan — tidak ada _blind signing_, tidak ada broadcast tanpa simulasi, dan tidak ada konfirmasi otomatis tanpa persetujuan pengguna.

---

## Daftar Isi

- [Fitur Utama](#fitur-utama)
- [Arsitektur](#arsitektur)
- [Persyaratan](#persyaratan)
- [Instalasi](#instalasi)
- [Konfigurasi](#konfigurasi)
- [Penggunaan](#penggunaan)
- [Strategi Biaya EIP-1559](#strategi-biaya-eip-1559)
- [Perlindungan MEV (Flashbots Protect)](#perlindungan-mev-flashbots-protect)
- [Aturan Keamanan](#aturan-keamanan)
- [Pemecahan Masalah](#pemecahan-masalah)
- [Lisensi](#lisensi)

## Fitur Utama

| Fitur | Deskripsi |
| --- | --- |
| _Ethereum-only_ | Memvalidasi `chainId == 1` di tiap _run_; menolak chain lain. |
| Resolusi ENS | `NFT_CONTRACT` boleh berupa nama ENS (mis. `azuki.eth`). |
| Verifikasi bytecode | Memastikan alamat kontrak benar-benar memiliki kode. |
| ABI minimal | Hanya fungsi mint yang Anda tulis di `.env`, mencegah _blind signing_. |
| Simulasi `staticCall` | Mendeteksi _revert_ sebelum gas terbuang. |
| Estimasi _tip_ via `eth_feeHistory` | Persentil ke-N dari N blok terakhir, jauh lebih akurat dari `getFeeData`. |
| Fallback Chainlink Fast Gas | On-chain oracle dipakai otomatis jika `eth_feeHistory` tidak tersedia. |
| Fallback `getFeeData` | Lapisan pamungkas jika feed Chainlink stale / dideprekasi. |
| Strategi EIP-1559 | `maxFeePerGas = 2 × baseFee + tip`, dengan _hard cap_. |
| Batas biaya keras | `MAX_FEE_GWEI`, `MAX_PRIORITY_GWEI`, `MAX_TOTAL_COST_ETH`. |
| Cek saldo | Saldo wallet dicek vs total biaya sebelum prompt konfirmasi. |
| Konfirmasi eksplisit | Prompt `y/N` di terminal sebelum broadcast. |
| _Pending nonce_ | Dipakai eksplisit untuk menghindari konflik nonce yang macet. |
| Konfirmasi multi-blok | `CONFIRMATIONS` (default 1) untuk ketahanan _reorg_. |
| Retry cerdas | Hanya retry pada error transien (blockhash, _rate-limit_, RPC). |
| _Etherscan link_ | Tautan kontrak dan tx otomatis dicetak. |
| Dukungan Flashbots Protect | Cukup ganti `RPC_URL`; tx tidak melewati mempool publik. |

## Arsitektur

```
src/
├── index.js       # Entry CLI, parsing argumen
├── config.js      # Memuat & memvalidasi .env (chainId dipaku ke 1)
├── provider.js    # JsonRpcProvider + Wallet, refuse jika bukan mainnet
├── contract.js    # ENS resolve, verifikasi bytecode, ABI minimal
├── oracle.js      # Chainlink Fast Gas oracle (deteksi stale & decommissioned)
├── simulate.js    # staticCall, rantai fallback fee, strategi EIP-1559
└── aco.js         # Orkestrasi: verify -> simulate -> fee plan -> confirm -> send -> retry
```

## Persyaratan

- **Node.js** versi 18 atau lebih baru
- **RPC endpoint Ethereum Mainnet** (Alchemy / Infura / Flashbots Protect / node pribadi)
- **Burner wallet** dengan saldo cukup untuk `mint price + biaya gas`

> **PENTING:** Jangan pernah menggunakan dompet utama Anda. Buat dompet baru khusus untuk operasi ini.

## Instalasi

```bash
git clone https://github.com/Khaerlwww/ACO.git
cd ACO
npm install
cp .env.example .env
```

## Konfigurasi

Edit berkas `.env`. Variabel yang tersedia:

### Jaringan dan dompet

| Variabel | Wajib | Deskripsi |
| --- | --- | --- |
| `RPC_URL` | Ya | RPC Ethereum Mainnet. Boleh juga Flashbots Protect. |
| `USING_FLASHBOTS_PROTECT` | Tidak | `true`/`false`, hanya untuk label di output. |
| `PRIVATE_KEY` | Ya | _Private key_ dompet **burner** (`0x...`). |

### Target NFT

| Variabel | Wajib | Deskripsi |
| --- | --- | --- |
| `NFT_CONTRACT` | Ya | Alamat `0x...` atau nama ENS (mis. `vault.azuki.eth`). |
| `MINT_FN` | Ya | Tanda tangan fungsi mint (lihat tabel di bawah). |
| `MINT_ARGS` | Ya | Argumen dipisah koma. `{WALLET}` diganti alamat dompet. |
| `MINT_PRICE_ETH` | Tidak | Harga per token dalam ETH. Default `0`. |
| `QUANTITY` | Tidak | Jumlah token. Default `1`. |

### Strategi biaya

| Variabel | Default | Deskripsi |
| --- | --- | --- |
| `MAX_FEE_GWEI` | `20` | Batas atas `maxFeePerGas`. |
| `MAX_PRIORITY_GWEI` | `1` | Batas atas `maxPriorityFeePerGas`. |
| `MAX_TOTAL_COST_ETH` | `0.05` | Batas atas total biaya (gas + value). |
| `FEE_HISTORY_BLOCKS` | `20` | Jumlah blok untuk `eth_feeHistory`. |
| `TIP_PERCENTILE` | `50` | Persentil _tip_ yang diambil dari riwayat. |
| `USE_CHAINLINK_FALLBACK` | `true` | Aktifkan fallback ke Chainlink Fast Gas oracle. |
| `CHAINLINK_FAST_GAS_FEED` | `0x169E...37C` | Alamat feed Chainlink Fast Gas / Gwei. |
| `CONFIRMATIONS` | `1` | Jumlah konfirmasi sebelum dianggap final. |
| `MAX_RETRIES` | `3` | Maksimum percobaan ulang pada error transien. |
| `RETRY_DELAY_MS` | `1500` | Jeda antar percobaan. |

### Contoh pasangan `MINT_FN` dan `MINT_ARGS`

| Skenario | `MINT_FN` | `MINT_ARGS` |
| --- | --- | --- |
| Mint sederhana | `mint(uint256)` | `1` |
| Mint dengan recipient | `mint(address,uint256)` | `{WALLET},1` |
| Public mint | `publicMint(uint256)` | `1` |
| Allowlist (tanpa proof) | `allowlistMint(uint256)` | `1` |

## Penggunaan

```bash
# 1. Simulasi saja (tidak pernah broadcast)
npm run dry

# 2. Simulasi, lalu minta konfirmasi sebelum broadcast
npm run send

# 3. Lihat bantuan
node src/index.js --help
```

## Strategi Biaya EIP-1559

Skrip menggunakan **rantai fallback bertingkat** untuk estimasi tip:

```
1. eth_feeHistory                         (paling akurat)
   ↓ kalau gagal/RPC tidak dukung
2. Chainlink Fast Gas oracle (on-chain)   (deteksi stale & decommissioned)
   ↓ kalau gagal/feed dideprekasi
3. provider.getFeeData()                  (lapisan terakhir)
```

Setelah tip didapat dari salah satu sumber, dihitung:

```
tip       = clamp(tip_dari_sumber, 0.01 gwei, MAX_PRIORITY_GWEI)
maxFee    = (baseFee × 2) + tip
```

Faktor `2 ×` pada `baseFee` memberi ruang lonjakan ~6 blok ke depan: karena `baseFee` maksimum naik 12.5% per blok, batas atas pertumbuhan dalam 6 blok adalah `1.125^6 ≈ 2.03`.

Jika `maxFee` melebihi `MAX_FEE_GWEI`, skrip menolak (tidak diam-diam menaikkan).

## Perlindungan MEV (Flashbots Protect)

Mint NFT di mainnet sering jadi sasaran _front-running_ dan _sandwich attack_. Untuk meminimalkan risiko, ganti `RPC_URL` ke endpoint **Flashbots Protect**:

```
RPC_URL=https://rpc.flashbots.net
USING_FLASHBOTS_PROTECT=true
```

Transaksi yang dikirim lewat endpoint ini **tidak masuk mempool publik**, sehingga tidak bisa di-_sandwich_ atau diintip _searcher_.

> Catatan: Flashbots Protect menambah latensi (transaksi dipublikasikan via _bundle_), jadi tidak ideal untuk mint yang super kompetitif di blok pertama.

## Aturan Keamanan

- **Hanya gunakan _burner wallet_.**
- **Tidak ada `approve` / `setApprovalForAll`.**
- **Tidak ada _blind signing_.** ABI dibangun dari fungsi tunggal yang Anda tulis sendiri.
- **Tidak ada transmisi private key.** Kunci hanya ada di proses lokal Anda.
- **Tidak ada bypass batas.** `MAX_FEE_GWEI`, `MAX_PRIORITY_GWEI`, `MAX_TOTAL_COST_ETH` ditegakkan sebagai _hard fail_.
- **Chain dipaku.** Jika RPC tidak melaporkan `chainId == 1`, skrip menolak menjalankan apa pun.
- **Cek saldo otomatis.** Skrip menolak mengirim kalau saldo wallet < estimasi total biaya.
- **Tidak ada retry untuk revert nyata.** Hanya error transien yang di-retry.

## Hardening Production

Untuk mengurangi risiko eksekusi tidak sengaja & penyalahgunaan konfigurasi:

### 1. Gerbang ganda untuk broadcast

Untuk mengirim transaksi nyata, **dua hal wajib aktif bersamaan**:

```bash
# Di .env
LIVE_MINT_APPROVED=yes

# Di terminal
npm run send
```

Tanpa salah satunya, broadcast diblokir. Ini mencegah skenario seperti:
- Anda sengaja jalankan `npm run send` saat sebenarnya ingin `npm run dry`.
- Otomatisasi/CI yang tidak sengaja memicu broadcast.

### 2. Denylist fungsi berbahaya

Skrip menolak `MINT_FN` yang nama fungsinya termasuk:

| Kategori | Contoh fungsi |
| --- | --- |
| Persetujuan token | `approve`, `setApprovalForAll`, `permit`, `increaseAllowance` |
| Transfer keluar | `transfer`, `transferFrom`, `safeTransferFrom` |
| Penghancuran | `burn`, `burnFrom` |
| Penarikan dana | `withdraw`, `withdrawAll`, `withdrawTo` |
| Kontrol kontrak | `transferOwnership`, `renounceOwnership`, `delegate` |
| Eksekusi arbitrer | `execute`, `execTransaction`, `multicall` |

Ini mencegah skenario di mana attacker mengarahkan Anda untuk set `MINT_FN=approve(address,uint256)` dengan spender attacker.

Kalau Anda yakin butuh fungsi ini, set `ALLOW_DANGEROUS_FN=true` di `.env`. **Disarankan tidak.**

### 3. Sensor RPC URL pada output

Output skrip otomatis menyensor:
- _Basic auth_ di URL (`user:pass@host`)
- _Path segment_ panjang (≥16 karakter — pola Alchemy/Infura key)
- _Query parameter_: `key`, `apikey`, `api_key`, `token`, `auth`, `secret`, `access_token`, `password`

Aman untuk _share_ keluaran terminal saat _troubleshooting_.

### 4. Lockfile dependency

Repo ini menyertakan `package-lock.json` agar `npm install` selalu menghasilkan _dependency tree_ yang sama (mencegah _supply-chain attack_ via versi transitive yang berubah). Kalau Anda butuh _override_, gunakan `npm ci` daripada `npm install` di lingkungan production.

## Pemecahan Masalah

| Pesan error | Penyebab umum | Solusi |
| --- | --- | --- |
| `RPC bukan Ethereum Mainnet` | RPC mengarah ke L2/testnet. | Ganti `RPC_URL` ke endpoint mainnet. |
| `PRIVATE_KEY format tidak valid` | Placeholder belum diganti. | Isi dengan private key burner asli. |
| `Nama ENS tidak bisa diresolusi` | ENS belum terdaftar atau salah ketik. | Cek di [app.ens.domains](https://app.ens.domains). |
| `Tidak ada bytecode di ...` | Alamat salah atau kontrak belum di-deploy. | Verifikasi di Etherscan. |
| `Simulasi revert: ...` | Mint belum live, allowlist, supply habis, dll. | Baca pesan revert; cek status mint. |
| `Estimasi maxFeePerGas ... melebihi batas` | Gas mainnet sedang naik. | Tunggu, atau naikkan `MAX_FEE_GWEI` jika wajar. |
| `Total biaya ... melebihi batas` | Gas + value > `MAX_TOTAL_COST_ETH`. | Sesuaikan batas atau kurangi `QUANTITY`. |
| `Saldo wallet ... kurang dari estimasi` | Burner wallet kurang ETH. | Top up wallet dengan ETH yang cukup. |
| `Jumlah argumen tidak cocok` | `MINT_ARGS` jumlahnya salah. | Hitung ulang sesuai `MINT_FN`. |
| `Broadcast diblokir oleh hardening gate` | `LIVE_MINT_APPROVED` belum di-set. | Set `LIVE_MINT_APPROVED=yes` di `.env` (lihat [Hardening](#hardening-production)). |
| `MINT_FN ... adalah fungsi yang berpotensi berbahaya` | Anda menulis fungsi non-mint (mis. `approve`). | Pastikan `MINT_FN` adalah fungsi mint kontrak. Kalau memang sengaja, set `ALLOW_DANGEROUS_FN=true`. |

## Lisensi

[MIT](./LICENSE)
