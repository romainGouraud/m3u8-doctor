/**
 * AES-128-CBC decryption of a segment PREFIX with WebCrypto (Node >= 20 and
 * browsers). WebCrypto enforces PKCS#7 padding on decrypt, which a truncated
 * prefix never has: we append one forged block that decrypts to a full
 * padding block, then drop it.
 */

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto is not available in this runtime');
  return s;
}

/** Copy into a plain ArrayBuffer-backed view, as WebCrypto requires. */
function own(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}

export async function aes128CbcDecryptPrefix(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const usable = data.byteLength - (data.byteLength % 16);
  if (usable === 0) return new Uint8Array(0);
  const cipher = data.subarray(0, usable);
  const k = await subtle().importKey('raw', own(key), { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
  // The forged block C' = E(K, P_pad XOR C_last): CBC-encrypting 16 bytes of 0x10
  // with IV = C_last yields exactly C' as its first block.
  const last = own(cipher.subarray(usable - 16, usable));
  const padBlock = new Uint8Array(16).fill(16);
  const forged = new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv: last }, k, padBlock)).subarray(0, 16);
  const joined = new Uint8Array(usable + 16);
  joined.set(cipher, 0);
  joined.set(forged, usable);
  return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv: own(iv) }, k, joined));
}

/** IV per RFC 8216 5.2: explicit IV attribute, else the media sequence number. */
export function hlsIv(ivAttr: string | null, sequence: number): Uint8Array {
  const iv = new Uint8Array(16);
  if (ivAttr && /^0x[0-9a-f]+$/i.test(ivAttr)) {
    const hex = ivAttr.slice(2).padStart(32, '0').slice(-32);
    for (let i = 0; i < 16; i++) iv[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return iv;
  }
  let n = BigInt(Math.max(0, Math.floor(sequence)));
  for (let i = 15; i >= 8 && n > 0n; i--) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}
