// Decodes a Radiance .hdr panorama off the main thread so VR keeps rendering smoothly.
// Output: 8-bit sRGB RGBA pixels (tone mapped), bottom row first, ready for a THREE.DataTexture.
// Large files (e.g. 16k) are box-downsampled while decoding to stay under maxWidth.

self.onmessage = async e => {
  const { url, maxWidth, exposure } = e.data;
  try {
    const bytes = await download(url);
    self.postMessage({ type: 'progress', phase: 'decoding' });
    const out = decode(bytes, maxWidth, exposure);
    self.postMessage({ type: 'done', ...out }, [out.data.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
  // Compressed responses report the compressed size, so only trust it when not encoded.
  const total = res.headers.get('content-encoding') ? 0 : +res.headers.get('content-length') || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader(), chunks = [];
  // With a known size, write straight into one buffer so huge files are not held twice in memory.
  let bytes = total ? new Uint8Array(total) : null, offset = 0, lastSent = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes && offset + value.length <= bytes.length) bytes.set(value, offset); else chunks.push(value);
    offset += value.length;
    const step = total ? Math.floor(offset / total * 100) : offset >> 21; // every 1% or every 2 MB
    if (step !== lastSent) { lastSent = step; self.postMessage({ type: 'progress', phase: 'downloading', pct: total ? step : -1, loaded: offset }); }
  }
  if (bytes && !chunks.length) return bytes;
  const all = new Uint8Array(offset); let o = 0;
  if (bytes) { all.set(bytes.subarray(0, Math.min(bytes.length, offset))); o = Math.min(bytes.length, offset); }
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}

function decode(bytes, maxWidth, exposure = 1) {
  // Header: text lines until an empty line, then the resolution line ("-Y 4096 +X 8192").
  let pos = 0;
  const line = () => { let s = ''; while (pos < bytes.length && bytes[pos] !== 10) s += String.fromCharCode(bytes[pos++]); pos++; return s; };
  if (!line().startsWith('#?')) throw new Error('Not a Radiance .hdr file');
  for (let l = line(); l.trim() !== ''; l = line()) {
    if (l.startsWith('FORMAT=') && !l.includes('32-bit_rle_rgbe')) throw new Error('Unsupported HDR format: ' + l);
  }
  const res = line().match(/-Y\s+(\d+)\s+\+X\s+(\d+)/);
  if (!res) throw new Error('Unsupported HDR orientation');
  const height = +res[1], width = +res[2];

  const factor = Math.max(1, Math.ceil(width / maxWidth));
  const outW = Math.floor(width / factor), outH = Math.floor(height / factor);
  const data = new Uint8Array(outW * outH * 4);
  const row = new Uint8Array(width * 4), acc = new Float32Array(outW * 3);

  // RGBE exponent -> scale, and tone mapped [0,1] -> sRGB byte lookup tables.
  const scale = new Float32Array(256);
  for (let e = 1; e < 256; e++) scale[e] = Math.pow(2, e - 136) * exposure / (factor * factor);
  const LUT = 4096, srgb = new Uint8Array(LUT + 1);
  for (let i = 0; i <= LUT; i++) { const v = i / LUT; srgb[i] = Math.round(255 * (v <= .0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - .055)); }
  const aces = x => { const v = x * (2.51 * x + .03) / (x * (2.43 * x + .59) + .14); return srgb[Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * LUT)]; };

  for (let y = 0; y < outH * factor; y++) {
    pos = readScanline(bytes, pos, row, width);
    for (let x = 0; x < outW * factor; x++) {
      const i = x * 4, s = scale[row[i + 3]], o = ((x / factor) | 0) * 3;
      acc[o] += row[i] * s; acc[o + 1] += row[i + 1] * s; acc[o + 2] += row[i + 2] * s;
    }
    if ((y + 1) % factor === 0) {
      // .hdr stores the top row first; WebGL DataTextures expect the bottom row first.
      let d = (outH - 1 - (y / factor | 0)) * outW * 4;
      for (let x = 0; x < outW; x++, d += 4) {
        data[d] = aces(acc[x * 3]); data[d + 1] = aces(acc[x * 3 + 1]); data[d + 2] = aces(acc[x * 3 + 2]); data[d + 3] = 255;
      }
      acc.fill(0);
    }
  }
  return { width: outW, height: outH, data };
}

function readScanline(bytes, pos, row, width) {
  const rle = width >= 8 && width < 32768 && bytes[pos] === 2 && bytes[pos + 1] === 2 && !(bytes[pos + 2] & 128);
  if (!rle) { row.set(bytes.subarray(pos, pos + width * 4)); return pos + width * 4; }
  pos += 4;
  for (let c = 0; c < 4; c++) {
    let x = 0;
    while (x < width) {
      let count = bytes[pos++];
      if (count > 128) { count -= 128; const v = bytes[pos++]; while (count--) row[(x++) * 4 + c] = v; }
      else { while (count--) row[(x++) * 4 + c] = bytes[pos++]; }
    }
  }
  return pos;
}
