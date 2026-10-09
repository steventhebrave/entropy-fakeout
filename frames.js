/*
 * Entropy Fakeout: drawing particles and exporting animation frames as PNG
 * files. Shared by both pages.
 *
 * Frames go into a folder the user picks (Chromium-based browsers, which can
 * write files directly), or into a ZIP file that downloads at the end.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EntropyFrames = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /*
   * Fill discs of radius r centred at xy[base + 2i], xy[base + 2i + 1], one
   * path per colour. colours[label] is each label's colour; with no labels,
   * every disc gets colours[0].
   */
  function drawDiscs(ctx, xy, base, n, r, labels, colours) {
    for (let c = 0; c < colours.length; c++) {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (labels ? labels[i] !== c : c !== 0) continue;
        const x = xy[base + 2 * i];
        const y = xy[base + 2 * i + 1];
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, 2 * Math.PI);
      }
      ctx.fillStyle = colours[c];
      ctx.fill();
    }
  }

  // ---------- ZIP (stored, no compression: PNGs are compressed already) ----------

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01, the earliest a ZIP can say

  class ZipWriter {
    constructor() {
      this.parts = [];
      this.entries = [];
      this.offset = 0;
    }

    async add(name, blob) {
      const data = new Uint8Array(await blob.arrayBuffer());
      const nameBytes = new TextEncoder().encode(name);
      const crc = crc32(data);
      if (this.offset + 30 + nameBytes.length + data.length > 0xffffffff || this.entries.length >= 0xffff) {
        throw new Error(
          'This export is too big for a ZIP file. Use a Chromium-based browser, which saves frames straight to a folder.'
        );
      }
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); // local file header
      h.setUint16(4, 20, true); // version needed
      h.setUint16(8, 0, true); // stored
      h.setUint16(12, DOS_DATE, true);
      h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true);
      h.setUint32(22, data.length, true);
      h.setUint16(26, nameBytes.length, true);
      this.parts.push(h, nameBytes, blob);
      this.entries.push({ nameBytes, crc, size: data.length, offset: this.offset });
      this.offset += 30 + nameBytes.length + data.length;
    }

    finish() {
      const central = [];
      let size = 0;
      for (const e of this.entries) {
        const h = new DataView(new ArrayBuffer(46));
        h.setUint32(0, 0x02014b50, true); // central directory header
        h.setUint16(4, 20, true); // version made by
        h.setUint16(6, 20, true); // version needed
        h.setUint16(10, 0, true); // stored
        h.setUint16(14, DOS_DATE, true);
        h.setUint32(16, e.crc, true);
        h.setUint32(20, e.size, true);
        h.setUint32(24, e.size, true);
        h.setUint16(28, e.nameBytes.length, true);
        h.setUint32(42, e.offset, true);
        central.push(h, e.nameBytes);
        size += 46 + e.nameBytes.length;
      }
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true); // end of central directory
      end.setUint16(8, this.entries.length, true);
      end.setUint16(10, this.entries.length, true);
      end.setUint32(12, size, true);
      end.setUint32(16, this.offset, true);
      return new Blob([...this.parts, ...central, end], { type: 'application/zip' });
    }
  }

  // ---------- export ----------

  // Why exporting can't work here, or '' if it can. Inside a frame (such as
  // a page viewer) the browser blocks both folder access and downloads.
  function unavailableReason() {
    let framed = true;
    try {
      framed = window.self !== window.top;
    } catch (_) {
      // a cross-origin parent: framed
    }
    return framed ? 'Exporting frames only works with the page opened directly from your copy of the files.' : '';
  }

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // Where the frames go. Asks for a folder where the browser allows it.
  async function openDestination(name) {
    if (typeof window.showDirectoryPicker === 'function') {
      const parent = await window.showDirectoryPicker({ id: 'entropy-frames', mode: 'readwrite' });
      const dir = await parent.getDirectoryHandle(name, { create: true });
      return {
        where: `the folder ${parent.name}/${name}`,
        async add(file, blob) {
          const handle = await dir.getFileHandle(file, { create: true });
          const out = await handle.createWritable();
          await out.write(blob);
          await out.close();
        },
        async finish() {},
        keepsPartial: true,
      };
    }
    const zip = new ZipWriter();
    return {
      where: `${name}.zip`,
      add: (file, blob) => zip.add(file, blob),
      finish: async () => download(zip.finish(), `${name}.zip`),
      keepsPartial: false,
    };
  }

  /*
   * Render frames 0 .. count - 1 at width × height and save them as
   * frame_00000.png and so on. draw(ctx, k) paints frame k. stopped() is
   * checked between frames. Resolves to { saved, where, stopped }. Throws
   * if the user cancels the folder picker (AbortError) or saving fails.
   */
  async function exportFrames({ name, count, width, height, draw, onProgress, stopped }) {
    const dest = await openDestination(name);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const digits = Math.max(5, String(count - 1).length);
    let saved = 0;
    for (let k = 0; k < count; k++) {
      if (stopped()) break;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      draw(ctx, k);
      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The browser could not encode a frame.'))), 'image/png')
      );
      await dest.add(`frame_${String(k).padStart(digits, '0')}.png`, blob);
      saved++;
      onProgress(saved, count);
    }
    const complete = saved === count;
    if (complete || dest.keepsPartial) await dest.finish();
    return { saved, where: dest.where, stopped: !complete, kept: complete || dest.keepsPartial };
  }

  return { drawDiscs, crc32, ZipWriter, unavailableReason, exportFrames };
});
