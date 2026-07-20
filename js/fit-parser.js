/*
 * Minimal FIT file parser — extracts `record` messages (timestamp, heart rate,
 * and a few extras) from Garmin .FIT activity files, entirely in the browser.
 *
 * Supports: normal & compressed-timestamp record headers, little/big endian
 * definition messages, developer data fields (skipped), chained FIT files.
 *
 * FIT protocol reference: https://developer.garmin.com/fit/protocol/
 */
(function (global) {
  'use strict';

  // Seconds between the Unix epoch and the FIT epoch (1989-12-31T00:00:00Z).
  var FIT_EPOCH_OFFSET = 631065600;

  // Base type number -> { size, invalid, read }. Field sizes in definition
  // messages are authoritative for advancing the offset; these sizes are only
  // used to decide whether a field is a scalar we can decode.
  var BASE_TYPES = {
    0x00: { size: 1, invalid: 0xFF, read: function (dv, o) { return dv.getUint8(o); } },        // enum
    0x01: { size: 1, invalid: 0x7F, read: function (dv, o) { return dv.getInt8(o); } },         // sint8
    0x02: { size: 1, invalid: 0xFF, read: function (dv, o) { return dv.getUint8(o); } },        // uint8
    0x83: { size: 2, invalid: 0x7FFF, read: function (dv, o, le) { return dv.getInt16(o, le); } },
    0x84: { size: 2, invalid: 0xFFFF, read: function (dv, o, le) { return dv.getUint16(o, le); } },
    0x85: { size: 4, invalid: 0x7FFFFFFF, read: function (dv, o, le) { return dv.getInt32(o, le); } },
    0x86: { size: 4, invalid: 0xFFFFFFFF, read: function (dv, o, le) { return dv.getUint32(o, le); } },
    0x07: { size: 1, invalid: 0x00, read: function (dv, o) { return dv.getUint8(o); } },        // string (byte-wise)
    0x88: { size: 4, invalid: null, read: function (dv, o, le) { return dv.getFloat32(o, le); } },
    0x89: { size: 8, invalid: null, read: function (dv, o, le) { return dv.getFloat64(o, le); } },
    0x0A: { size: 1, invalid: 0x00, read: function (dv, o) { return dv.getUint8(o); } },        // uint8z
    0x8B: { size: 2, invalid: 0x0000, read: function (dv, o, le) { return dv.getUint16(o, le); } }, // uint16z
    0x8C: { size: 4, invalid: 0x00000000, read: function (dv, o, le) { return dv.getUint32(o, le); } }, // uint32z
    0x0D: { size: 1, invalid: 0xFF, read: function (dv, o) { return dv.getUint8(o); } },        // byte
    0x8E: { size: 8, invalid: null, read: function (dv, o, le) { return Number(dv.getBigInt64(o, le)); } },
    0x8F: { size: 8, invalid: null, read: function (dv, o, le) { return Number(dv.getBigUint64(o, le)); } },
    0x90: { size: 8, invalid: 0, read: function (dv, o, le) { return Number(dv.getBigUint64(o, le)); } }
  };

  var SPORT_NAMES = {
    0: 'Generic', 1: 'Running', 2: 'Cycling', 3: 'Transition',
    4: 'Fitness equipment', 5: 'Swimming', 6: 'Basketball', 7: 'Soccer',
    8: 'Tennis', 9: 'American football', 10: 'Training', 11: 'Walking',
    12: 'Cross-country skiing', 13: 'Alpine skiing', 14: 'Snowboarding',
    15: 'Rowing', 16: 'Mountaineering', 17: 'Hiking', 18: 'Multisport',
    19: 'Paddling', 21: 'E-biking', 25: 'Inline skating', 26: 'Rock climbing',
    27: 'Sailing', 31: 'Golf', 37: 'Stand-up paddleboarding', 41: 'Kayaking',
    43: 'Snowshoeing', 62: 'Hand cycling', 64: 'Racket', 76: 'Water tubing',
    77: 'Wakesurfing'
  };

  var SUB_SPORT_NAMES = {
    0: 'Generic', 1: 'Treadmill', 2: 'Street', 3: 'Trail', 4: 'Track',
    5: 'Spin', 6: 'Indoor cycling', 7: 'Road', 8: 'Mountain', 9: 'Downhill',
    10: 'Recumbent', 11: 'Cyclocross', 12: 'Hand cycling', 13: 'Track cycling',
    14: 'Indoor rowing', 15: 'Elliptical', 16: 'Stair climbing',
    17: 'Lap swimming', 18: 'Open water', 19: 'Flexibility training',
    20: 'Strength training', 58: 'Virtual activity'
  };

  // Global message numbers we decode.
  var MESG_RECORD = 20;
  var MESG_SESSION = 18;

  function parseFit(arrayBuffer) {
    var dv = new DataView(arrayBuffer);
    var bytes = new Uint8Array(arrayBuffer);
    var records = [];
    var sports = [];
    var subSports = [];
    var flags = { hasGps: false };
    var offset = 0;
    var fileCount = 0;

    // FIT files can be chained: header + data + CRC, repeated.
    while (offset + 12 <= dv.byteLength) {
      var headerSize = dv.getUint8(offset);
      if ((headerSize !== 12 && headerSize !== 14) || offset + headerSize > dv.byteLength) break;
      // ".FIT" signature at header bytes 8..11
      if (bytes[offset + 8] !== 0x2E || bytes[offset + 9] !== 0x46 ||
          bytes[offset + 10] !== 0x49 || bytes[offset + 11] !== 0x54) break;
      var dataSize = dv.getUint32(offset + 4, true);
      var dataStart = offset + headerSize;
      var dataEnd = dataStart + dataSize;
      if (dataEnd > dv.byteLength) {
        // Truncated file: parse what we can.
        dataEnd = dv.byteLength;
      }
      parseSection(dv, dataStart, dataEnd, records, sports, subSports, flags);
      fileCount++;
      offset = dataEnd + 2; // skip trailing CRC
    }

    if (fileCount === 0) {
      throw new Error('Not a FIT file (missing ".FIT" header signature).');
    }

    return { records: records, sports: sports, subSports: subSports, hasGps: flags.hasGps };
  }

  function parseSection(dv, start, end, records, sports, subSports, flags) {
    var offset = start;
    var definitions = {};  // local message type -> definition
    var lastTimestamp = null;

    while (offset < end) {
      var header = dv.getUint8(offset); offset++;
      var localType, compressedOffset = null;

      if (header & 0x80) {
        // Compressed timestamp header: data message, 5-bit time offset.
        localType = (header >> 5) & 0x03;
        compressedOffset = header & 0x1F;
      } else if (header & 0x40) {
        // Definition message.
        localType = header & 0x0F;
        var hasDevFields = (header & 0x20) !== 0;
        if (offset + 5 > end) return;
        var littleEndian = dv.getUint8(offset + 1) === 0;
        var globalNum = littleEndian ? dv.getUint16(offset + 2, true) : dv.getUint16(offset + 2, false);
        var numFields = dv.getUint8(offset + 4);
        offset += 5;
        if (offset + numFields * 3 > end) return;
        var fields = [];
        var totalSize = 0;
        for (var i = 0; i < numFields; i++) {
          var fieldNum = dv.getUint8(offset);
          var size = dv.getUint8(offset + 1);
          var baseType = dv.getUint8(offset + 2);
          fields.push({ num: fieldNum, size: size, baseType: baseType });
          totalSize += size;
          offset += 3;
        }
        var devSize = 0;
        if (hasDevFields) {
          if (offset >= end) return;
          var numDev = dv.getUint8(offset); offset++;
          if (offset + numDev * 3 > end) return;
          for (var j = 0; j < numDev; j++) {
            devSize += dv.getUint8(offset + 1);
            offset += 3;
          }
        }
        definitions[localType] = {
          littleEndian: littleEndian,
          globalNum: globalNum,
          fields: fields,
          totalSize: totalSize + devSize
        };
        continue;
      } else {
        // Normal data message header.
        localType = header & 0x0F;
      }

      var def = definitions[localType];
      if (!def) {
        // Undecodable stream from here on; bail out of this section.
        return;
      }
      if (offset + def.totalSize > end) return;

      if (def.globalNum === MESG_RECORD || def.globalNum === MESG_SESSION) {
        var values = {};
        var fo = offset;
        for (var k = 0; k < def.fields.length; k++) {
          var f = def.fields[k];
          var bt = BASE_TYPES[f.baseType & 0x9F];
          // Only decode scalars of known base types; always advance by size.
          if (bt && f.size === bt.size) {
            var v = bt.read(dv, fo, def.littleEndian);
            if (bt.invalid === null || v !== bt.invalid) values[f.num] = v;
          }
          fo += f.size;
        }
        if (def.globalNum === MESG_RECORD) {
          // position_lat (0) / position_long (1): any valid fix means real GPS.
          if (values[0] !== undefined || values[1] !== undefined) flags.hasGps = true;
          var ts = null;
          if (values[253] !== undefined) {
            ts = values[253];
            lastTimestamp = ts;
          } else if (compressedOffset !== null && lastTimestamp !== null) {
            var base = lastTimestamp & ~0x1F;
            ts = base + compressedOffset;
            if (compressedOffset < (lastTimestamp & 0x1F)) ts += 0x20;
            lastTimestamp = ts;
          }
          var rec = { t: ts !== null ? ts + FIT_EPOCH_OFFSET : null };
          if (values[3] !== undefined) rec.hr = values[3];               // heart_rate (bpm)
          if (values[4] !== undefined) rec.cadence = values[4];          // rpm/spm
          if (values[5] !== undefined) rec.distance = values[5] / 100;   // m
          if (values[73] !== undefined) rec.speed = values[73] / 1000;   // enhanced_speed m/s
          else if (values[6] !== undefined) rec.speed = values[6] / 1000;
          if (values[78] !== undefined) rec.altitude = values[78] / 5 - 500; // enhanced_altitude m
          else if (values[2] !== undefined) rec.altitude = values[2] / 5 - 500;
          records.push(rec);
        } else { // session
          if (values[253] !== undefined) lastTimestamp = values[253];
          if (values[5] !== undefined) {
            sports.push(SPORT_NAMES[values[5]] || ('Sport #' + values[5]));
          }
          if (values[6] !== undefined) {
            subSports.push(SUB_SPORT_NAMES[values[6]] || ('Sub-sport #' + values[6]));
          }
        }
      } else {
        // Track timestamps from any message so compressed headers stay correct.
        var tsField = null;
        var fo2 = offset;
        for (var m = 0; m < def.fields.length; m++) {
          var f2 = def.fields[m];
          if (f2.num === 253 && f2.size === 4) { tsField = fo2; }
          fo2 += f2.size;
        }
        if (tsField !== null) {
          var tv = dv.getUint32(tsField, def.littleEndian);
          if (tv !== 0xFFFFFFFF) lastTimestamp = tv;
        }
      }
      offset += def.totalSize;
    }
  }

  var api = { parseFit: parseFit, FIT_EPOCH_OFFSET: FIT_EPOCH_OFFSET };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ATV = global.ATV || {};
  global.ATV.fit = api;
})(typeof window !== 'undefined' ? window : globalThis);
