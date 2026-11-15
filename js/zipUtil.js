/* ==========================================================
   ZIPアーカイブの最小限の読み書き（汎用）
   .xlsx編集機能（report-output/renderers/excelXlsxTemplate.js）と
   全データバックアップ機能（backup.js）の両方から使う共通基盤。
   外部ライブラリなし方針のため、ZIP仕様を直接実装している。
   方針: 変更しないエントリは元の圧縮バイト列をそのまま新しいZIPへ
   コピーし、書き換え／追加したエントリだけを無圧縮(STORED)で書き込む。
   ZIPは圧縮方式がエントリごとに混在してもよい仕様のため、これで
   問題なく開ける。読み込み側は標準のCompression Streams API
   （DecompressionStream）でdeflate展開する。
   ========================================================== */

const SIG_LOCAL_FILE = 0x04034b50;
const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 読み込むZIPの大きさの上限（2026-11-01。壊れた・悪意のあるZIPで端末のメモリを使い切らないため）。
 * 実際のファイル（実データのバックアップ 7.6MB・89ファイル・最大4.2MB、03-2の原本 展開後6.8MB・最大0.6MB・圧縮率17倍、
 * 写真は1枚 数百KB）より十分大きい値にしてある。バックアップの復元・テンプレートの登録・積算/見積のExcelの取込・出力の読み直しの
 * すべてが loadZip / readZipEntryBytes を通るので、ここで止めれば、どの経路でもデータを書き込む前に止まる。
 */
export const ZIP_LIMITS = {
  maxFileBytes: 1024 * 1024 * 1024, // ZIPファイル全体（iPadはファイル全体をメモリに読むので、これより大きいと扱えない）
  maxEntries: 20000, // ZIPの中のファイル数
  maxEntryBytes: 256 * 1024 * 1024, // 1ファイルの展開後
  maxTotalBytes: 2 * 1024 * 1024 * 1024 // 展開後の合計
};

const MB = (n) => `${Math.round(n / 1048576)}MB`;

/** deflate を展開する。expected（ZIPの中の申告の大きさ）を超えたら途中でやめ、展開後の大きさが申告と違えば誤りにする */
async function inflateRaw(bytes, expected, name = "") {
  const ds = new DecompressionStream("deflate-raw");
  const reader = new Blob([bytes]).stream().pipeThrough(ds).getReader();
  const out = new Uint8Array(expected);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > expected) {
      await reader.cancel().catch(() => {});
      throw new Error(`ZIPの中のファイル（${name}）が、申告された大きさより大きく展開されます（壊れたファイルか、不正なファイルの可能性があります）`);
    }
    out.set(value, n);
    n += value.length;
  }
  if (n !== expected) throw new Error(`ZIPの中のファイル（${name}）の大きさが申告と違います（壊れたファイルの可能性があります）`);
  return out;
}

/**
 * 既存ZIP（.xlsxやバックアップZIP等）をパースし、中央ディレクトリの
 * メタ情報を取り出す。
 * @returns {{buffer: Uint8Array, entries: Map<string, object>}}
 */
export function loadZip(arrayBuffer) {
  const buffer = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  if (buffer.length > ZIP_LIMITS.maxFileBytes) throw new Error(`ファイルが大きすぎます（${MB(buffer.length)}。読み込めるのは${MB(ZIP_LIMITS.maxFileBytes)}まで）`);

  // EOCDを末尾から探索（コメント長は可変のため）
  let eocdOffset = -1;
  const minEocd = 22;
  for (let i = buffer.length - minEocd; i >= 0 && i >= buffer.length - minEocd - 65535; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("有効なZIPファイルとして読み込めませんでした");

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (totalEntries > ZIP_LIMITS.maxEntries) throw new Error(`ZIPの中のファイルが多すぎます（${totalEntries}件。${ZIP_LIMITS.maxEntries}件まで）`);
  if (cdOffset >= buffer.length) throw new Error("中央ディレクトリの位置がファイルの外を指しています（壊れたファイルの可能性があります）");

  const entries = new Map();
  let ptr = cdOffset;
  let totalBytes = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (ptr + 46 > buffer.length || view.getUint32(ptr, true) !== SIG_CENTRAL_DIR) throw new Error("中央ディレクトリの解析に失敗しました");
    const method = view.getUint16(ptr + 10, true);
    const modTime = view.getUint16(ptr + 12, true);
    const modDate = view.getUint16(ptr + 14, true);
    const crc = view.getUint32(ptr + 16, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const uncompressedSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);
    const nameBytes = buffer.subarray(ptr + 46, ptr + 46 + nameLen);
    const name = new TextDecoder().decode(nameBytes);

    // 大きさ・名前・位置の検査（2026-11-01）。ZIP64（大きさが 0xFFFFFFFF）は扱わない
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new Error(`この形式のZIP（ZIP64）には対応していません（${name}）`);
    if (uncompressedSize > ZIP_LIMITS.maxEntryBytes) throw new Error(`ZIPの中のファイル（${name}）が大きすぎます（展開後${MB(uncompressedSize)}。1ファイル${MB(ZIP_LIMITS.maxEntryBytes)}まで）`);
    totalBytes += uncompressedSize;
    if (totalBytes > ZIP_LIMITS.maxTotalBytes) throw new Error(`ZIPを展開した後の合計が大きすぎます（${MB(ZIP_LIMITS.maxTotalBytes)}まで）`);
    if (name.includes("\0") || name.startsWith("/") || name.split("/").includes("..")) throw new Error(`ZIPの中のファイル名が不正です（${name}）`);
    if (method === 0 && compressedSize !== uncompressedSize) throw new Error(`ZIPの中のファイル（${name}）の大きさが不正です（壊れたファイルの可能性があります）`);
    if (localHeaderOffset + 30 > buffer.length) throw new Error(`ZIPの中のファイル（${name}）の位置がファイルの外を指しています`);

    // ローカルファイルヘッダ側のname/extra長を読み、実データの開始位置を求める。
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;
    if (dataOffset + compressedSize > buffer.length) throw new Error(`ZIPの中のファイル（${name}）のデータがファイルの外にはみ出しています（壊れたファイルの可能性があります）`);

    entries.set(name, { method, modTime, modDate, crc, compressedSize, uncompressedSize, dataOffset });

    ptr += 46 + nameLen + extraLen + commentLen;
  }

  return { buffer, entries };
}

export async function readZipEntryBytes(zip, name) {
  const entry = zip.entries.get(name);
  if (!entry) return null;
  const compressed = zip.buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === 0) return compressed.slice();
  if (entry.method === 8) return inflateRaw(compressed, entry.uncompressedSize, name);
  throw new Error(`未対応の圧縮方式です(method=${entry.method}): ${name}`);
}

export async function readZipEntryText(zip, name) {
  const bytes = await readZipEntryBytes(zip, name);
  return bytes ? new TextDecoder("utf-8").decode(bytes) : null;
}

function writeUint32(arr, offset, value) {
  new DataView(arr.buffer, arr.byteOffset, arr.byteLength).setUint32(offset, value >>> 0, true);
}
function writeUint16(arr, offset, value) {
  new DataView(arr.buffer, arr.byteOffset, arr.byteLength).setUint16(offset, value, true);
}

/**
 * 変更後のエントリを合成して新しいZIPのBlobを生成する。
 * 元エントリを1つも持たない空の`zip`（{buffer: new Uint8Array(0), entries: new Map()}）を
 * 渡せば、modificationsのみからなる全く新規のZIPを作れる（バックアップ作成用途）。
 * @param {{buffer: Uint8Array, entries: Map}} zip 元ZIPのパース結果（新規作成時は空でよい）
 * @param {Map<string, Uint8Array>} modifications 変更・追加するエントリ名→中身
 * @param {string} [mimeType]
 */
export function buildZip(zip, modifications, mimeType = "application/zip") {
  return buildZipInternal(zip, modifications, mimeType, null);
}

function buildZipInternal(zip, modifications, mimeType, precompressed) {
  const encoder = new TextEncoder();
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  const allNames = new Set([...zip.entries.keys(), ...modifications.keys()]);

  for (const name of allNames) {
    const nameBytes = encoder.encode(name);
    const changed = modifications.has(name);
    const original = zip.entries.get(name);

    let method, crc, compressedSize, uncompressedSize, compressedData, modTime, modDate;

    if (changed && precompressed?.has(name)) {
      const packed = precompressed.get(name);
      method = packed.method;
      crc = packed.crc;
      compressedSize = packed.data.length;
      uncompressedSize = packed.uncompressedSize;
      compressedData = packed.data;
      modTime = original?.modTime ?? 0;
      modDate = original?.modDate ?? 0x21;
    } else if (changed) {
      const content = modifications.get(name);
      method = 0; // 変更・追加エントリは無圧縮(STORED)で書き込む
      crc = crc32(content);
      compressedSize = content.length;
      uncompressedSize = content.length;
      compressedData = content;
      modTime = original?.modTime ?? 0;
      modDate = original?.modDate ?? 0x21; // 1980-01-01相当の妥当な既定値
    } else {
      method = original.method;
      crc = original.crc;
      compressedSize = original.compressedSize;
      uncompressedSize = original.uncompressedSize;
      compressedData = zip.buffer.subarray(original.dataOffset, original.dataOffset + original.compressedSize);
      modTime = original.modTime;
      modDate = original.modDate;
    }

    const localHeader = new Uint8Array(30 + nameBytes.length);
    writeUint32(localHeader, 0, SIG_LOCAL_FILE);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0);
    writeUint16(localHeader, 8, method);
    writeUint16(localHeader, 10, modTime);
    writeUint16(localHeader, 12, modDate);
    writeUint32(localHeader, 14, crc);
    writeUint32(localHeader, 18, compressedSize);
    writeUint32(localHeader, 22, uncompressedSize);
    writeUint16(localHeader, 26, nameBytes.length);
    writeUint16(localHeader, 28, 0);
    localHeader.set(nameBytes, 30);

    const localHeaderOffset = offset;
    localChunks.push(localHeader, compressedData);
    offset += localHeader.length + compressedData.length;

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    writeUint32(centralHeader, 0, SIG_CENTRAL_DIR);
    writeUint16(centralHeader, 4, 20);
    writeUint16(centralHeader, 6, 20);
    writeUint16(centralHeader, 8, 0);
    writeUint16(centralHeader, 10, method);
    writeUint16(centralHeader, 12, modTime);
    writeUint16(centralHeader, 14, modDate);
    writeUint32(centralHeader, 16, crc);
    writeUint32(centralHeader, 20, compressedSize);
    writeUint32(centralHeader, 24, uncompressedSize);
    writeUint16(centralHeader, 28, nameBytes.length);
    writeUint16(centralHeader, 30, 0);
    writeUint16(centralHeader, 32, 0);
    writeUint16(centralHeader, 34, 0);
    writeUint16(centralHeader, 36, 0);
    writeUint32(centralHeader, 38, 0);
    writeUint32(centralHeader, 42, localHeaderOffset);
    centralHeader.set(nameBytes, 46);
    centralChunks.push(centralHeader);
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const chunk of centralChunks) centralDirSize += chunk.length;

  const eocd = new Uint8Array(22);
  writeUint32(eocd, 0, SIG_EOCD);
  writeUint16(eocd, 4, 0);
  writeUint16(eocd, 6, 0);
  writeUint16(eocd, 8, allNames.size);
  writeUint16(eocd, 10, allNames.size);
  writeUint32(eocd, 12, centralDirSize);
  writeUint32(eocd, 16, centralDirOffset);
  writeUint16(eocd, 20, 0);

  return new Blob([...localChunks, ...centralChunks, eocd], { type: mimeType });
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * buildZipと同じ入力で、変更・追加したエントリをdeflate圧縮して書き込む版。
 * 台帳のように大きなシートXMLを作るときに、無圧縮（buildZip）だとファイルが数倍〜10倍に
 * 膨らむため、こちらを使う。変更しないエントリは元の圧縮バイト列のままコピーする。
 */
export async function buildZipCompressed(zip, modifications, mimeType = "application/zip") {
  const compressed = new Map();
  for (const [name, content] of modifications) {
    const packed = await deflateRaw(content);
    compressed.set(name, { method: 8, crc: crc32(content), uncompressedSize: content.length, data: packed });
  }
  return buildZipInternal(zip, modifications, mimeType, compressed);
}
