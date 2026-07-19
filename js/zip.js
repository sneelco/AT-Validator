/*
 * Minimal ZIP extractor — enough to pull the .fit file out of a Garmin
 * Connect "Export Original" zip without any library. Deflate entries are
 * decompressed with the browser's native DecompressionStream.
 */
(function (global) {
  'use strict';

  // Returns a Promise<{name, buffer}> for the first .fit entry (or, failing
  // that, the first entry of any kind) in the zip.
  async function extractFit(arrayBuffer) {
    var dv = new DataView(arrayBuffer);

    // Find the End Of Central Directory record (sig 0x06054b50), scanning
    // backwards over the trailing comment space.
    var eocd = -1;
    var scanStart = Math.max(dv.byteLength - 22 - 65535, 0);
    for (var i = dv.byteLength - 22; i >= scanStart; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip file.');

    var count = dv.getUint16(eocd + 10, true);
    var cdOffset = dv.getUint32(eocd + 16, true);

    var entries = [];
    var p = cdOffset;
    for (var e = 0; e < count && p + 46 <= dv.byteLength; e++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOffset = dv.getUint32(p + 42, true);
      var name = new TextDecoder().decode(new Uint8Array(arrayBuffer, p + 46, nameLen));
      entries.push({ name: name, method: method, compSize: compSize, localOffset: localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (!entries.length) throw new Error('Empty zip file.');

    var entry = entries.find(function (en) { return /\.fit$/i.test(en.name); }) || entries[0];

    // Local header: sizes of name/extra can differ from the central copy.
    var lo = entry.localOffset;
    if (dv.getUint32(lo, true) !== 0x04034b50) throw new Error('Corrupt zip entry.');
    var lNameLen = dv.getUint16(lo + 26, true);
    var lExtraLen = dv.getUint16(lo + 28, true);
    var dataStart = lo + 30 + lNameLen + lExtraLen;
    var comp = arrayBuffer.slice(dataStart, dataStart + entry.compSize);

    if (entry.method === 0) {
      return { name: entry.name, buffer: comp };
    }
    if (entry.method !== 8) throw new Error('Unsupported zip compression (method ' + entry.method + ').');
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot unzip — extract the .fit and upload it directly.');
    }
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([comp]).stream().pipeThrough(ds);
    var buffer = await new Response(stream).arrayBuffer();
    return { name: entry.name, buffer: buffer };
  }

  var api = { extractFit: extractFit };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ATV = global.ATV || {};
  global.ATV.zip = api;
})(typeof window !== 'undefined' ? window : globalThis);
