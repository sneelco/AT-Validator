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

  // Manufacturer IDs from the official FIT SDK profile (subset).
  var MANUFACTURER_NAMES = {
    1: 'Garmin', 13: 'Dynastream OEM', 15: 'Dynastream', 23: 'Suunto',
    32: 'Wahoo Fitness', 40: 'Concept2', 41: 'Shimano', 45: 'Xplova',
    56: 'Star Trac', 67: 'Bkool', 70: 'Sigma Sport', 73: 'Wattbike',
    80: 'Lifebeam', 83: 'Scosche', 85: 'Woodway', 89: 'Tacx',
    95: 'Stryd', 107: 'Magene', 111: 'Technogym', 121: 'Kinetic',
    122: 'Johnson Health Tech', 123: 'Polar', 135: 'Coospo', 150: 'Myzone',
    255: 'Development', 260: 'Zwift', 263: 'Favero Electronics', 265: 'Strava',
    266: 'Precor', 267: 'Bryton', 282: 'The Sufferfest', 289: 'Hammerhead',
    294: 'COROS', 310: 'Decathlon', 314: 'True Fitness', 340: 'Peloton'
  };

  // Garmin product IDs (curated subset of the FIT SDK profile).
  var GARMIN_PRODUCT_NAMES = {
    14: 'Forerunner 225 Single Byte Product Id', 717: 'Forerunner 405', 782: 'Forerunner 50',
    988: 'Forerunner 60', 1018: 'Forerunner 310xt', 1036: 'Edge 500',
    1124: 'Forerunner 110', 1169: 'Edge 800', 1325: 'Edge 200',
    1328: 'Forerunner 910xt', 1345: 'Forerunner 610', 1436: 'Forerunner 70',
    1446: 'Forerunner 310xt 4t', 1482: 'Forerunner 10', 1499: 'Swim',
    1551: 'Fenix', 1561: 'Edge 510', 1567: 'Edge 810',
    1623: 'Forerunner 620', 1632: 'Forerunner 220', 1736: 'Edge Touring',
    1765: 'Forerunner 920xt', 1836: 'Edge 1000', 1903: 'Forerunner 15',
    1967: 'Fenix 2', 1988: 'Epix', 2050: 'Fenix 3',
    2067: 'Edge 520', 2147: 'Edge 25', 2148: 'Forerunner 25',
    2153: 'Forerunner 225', 2156: 'Forerunner 630', 2157: 'Forerunner 230',
    2158: 'Forerunner 735xt', 2204: 'Edge Explore 1000', 2238: 'Edge 20',
    2413: 'Fenix 3 Hr', 2431: 'Forerunner 235', 2432: 'Fenix 3 Chronos',
    2503: 'Forerunner 35', 2530: 'Edge 820', 2531: 'Edge Explore 820',
    2544: 'Fenix 5s', 2604: 'Fenix 5x', 2691: 'Forerunner 935',
    2697: 'Fenix 5', 2700: 'Vivoactive 3', 2713: 'Edge 1030',
    2859: 'Descent', 2886: 'Forerunner 645', 2888: 'Forerunner 645m',
    2891: 'Forerunner 30', 2900: 'Fenix 5s Plus', 2988: 'Vivoactive 3m W',
    3011: 'Edge Explore', 3066: 'Vivoactive 3m L', 3076: 'Forerunner 245',
    3077: 'Forerunner 245 Music', 3110: 'Fenix 5 Plus', 3111: 'Fenix 5x Plus',
    3112: 'Edge 520 Plus', 3113: 'Forerunner 945', 3121: 'Edge 530',
    3122: 'Edge 830', 3126: 'Instinct Esports', 3143: 'Descent T1',
    3224: 'Vivoactive 4 Small', 3225: 'Vivoactive 4 Large', 3226: 'Venu',
    3246: 'Marq Driver', 3247: 'Marq Aviator', 3248: 'Marq Captain',
    3249: 'Marq Commander', 3250: 'Marq Expedition', 3251: 'Marq Athlete',
    3258: 'Descent Mk2', 3282: 'Forerunner 45', 3287: 'Fenix 6S Sport',
    3288: 'Fenix 6S', 3289: 'Fenix 6 Sport', 3290: 'Fenix 6',
    3291: 'Fenix 6x', 3405: 'Swim 2', 3466: 'Instinct Solar',
    3542: 'Descent Mk2s', 3558: 'Edge 130 Plus', 3570: 'Edge 1030 Plus',
    3589: 'Forerunner 745', 3596: 'Venusq Music', 3599: 'Venusq Music V2',
    3600: 'Venusq', 3624: 'Marq Adventurer', 3638: 'Enduro',
    3652: 'Forerunner 945 Lte', 3703: 'Venu 2', 3704: 'Venu 2s',
    3739: 'Marq Golfer', 3843: 'Edge 1040', 3851: 'Venu 2 Plus',
    3869: 'Forerunner 55', 3888: 'Instinct 2', 3889: 'Instinct 2s',
    3905: 'Fenix 7s', 3906: 'Fenix 7', 3907: 'Fenix 7x',
    3943: 'Epix Gen2', 3990: 'Forerunner 255 Music', 3991: 'Forerunner 255 Small Music',
    3992: 'Forerunner 255', 3993: 'Forerunner 255 Small', 4005: 'Descent G1',
    4024: 'Forerunner 955', 4061: 'Edge 540', 4062: 'Edge 840',
    4105: 'Marq Gen2', 4115: 'Venusq2', 4116: 'Venusq2music',
    4124: 'Marq Gen2 Aviator', 4135: 'Tactix 7', 4155: 'Instinct Crossover',
    4169: 'Edge Explore2', 4222: 'Descent Mk3', 4223: 'Descent Mk3i',
    4257: 'Forerunner 265 Large', 4258: 'Forerunner 265 Small', 4260: 'Venu 3',
    4261: 'Venu 3s', 4312: 'Epix Gen2 Pro 42', 4313: 'Epix Gen2 Pro 47',
    4314: 'Epix Gen2 Pro 51', 4315: 'Forerunner 965', 4341: 'Enduro 2',
    4374: 'Fenix 7s Pro Solar', 4375: 'Fenix 7 Pro Solar', 4376: 'Fenix 7x Pro Solar',
    4394: 'Instinct 2x', 4426: 'Vivoactive 5', 4432: 'Forerunner 165',
    4433: 'Forerunner 165 Music', 4440: 'Edge 1050', 4442: 'Descent T2',
    4472: 'Marq Gen2 Commander', 4532: 'Fenix 8 Solar', 4533: 'Fenix 8 Solar Large',
    4534: 'Fenix 8 Small', 4536: 'Fenix 8', 4575: 'Enduro 3',
    4583: 'Instincte 40mm', 4584: 'Instincte 45mm', 4585: 'Instinct 3 Solar 45mm',
    4586: 'Instinct 3 Amoled 45mm', 4587: 'Instinct 3 Amoled 50mm', 4588: 'Descent G2',
    4603: 'Venu X1', 4625: 'Vivoactive 6', 4631: 'Fenix 8 Pro',
    4633: 'Edge 550', 4634: 'Edge 850', 4643: 'Venu 4',
    4644: 'Venu 4s', 4655: 'Edge Mtb', 4666: 'Fenix E',
    4678: 'Instinct Crossover Amoled', 4759: 'Instinct 3 Solar 50mm', 4775: 'Tactix 8 Amoled',
    4776: 'Tactix 8 Solar', 4814: 'Forerunner 170 Music', 4815: 'Forerunner 170',
    4916: 'Forerunner 70 2026', 10014: 'Edge Remote'
  };

  // Global message numbers we decode.
  var MESG_RECORD = 20;
  var MESG_SESSION = 18;
  var MESG_FILE_ID = 0;
  var MESG_DEVICE_INFO = 23;

  function parseFit(arrayBuffer) {
    var dv = new DataView(arrayBuffer);
    var bytes = new Uint8Array(arrayBuffer);
    var records = [];
    var sports = [];
    var subSports = [];
    var meta = { hasGps: false, fileIds: [], deviceInfos: [], sessions: [] };
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
      parseSection(dv, dataStart, dataEnd, records, sports, subSports, meta);
      fileCount++;
      offset = dataEnd + 2; // skip trailing CRC
    }

    if (fileCount === 0) {
      throw new Error('Not a FIT file (missing ".FIT" header signature).');
    }

    return {
      records: records,
      sports: sports,
      subSports: subSports,
      hasGps: meta.hasGps,
      provenance: buildProvenance(meta),
      debug: { fileIds: meta.fileIds, deviceInfos: meta.deviceInfos, sessions: meta.sessions }
    };
  }

  // Who wrote this file, on what hardware — the basis for deciding whether
  // the speed channel is real (GPS, belt) or a wrist estimate.
  function buildProvenance(meta) {
    var mfgId, prodId, prodName, descriptor;
    if (meta.fileIds.length) {
      mfgId = meta.fileIds[0].manufacturer;
      prodId = meta.fileIds[0].product;
      prodName = meta.fileIds[0].productName;
    }
    for (var i = 0; i < meta.deviceInfos.length; i++) {
      var d = meta.deviceInfos[i];
      if (mfgId === undefined && d.manufacturer !== undefined) {
        mfgId = d.manufacturer;
        prodId = d.product;
      }
      if (d.manufacturer === mfgId) {
        descriptor = descriptor || d.descriptor;
        prodName = prodName || d.productName;
      }
    }
    var product = null;
    if (mfgId === 1 && prodId !== undefined && GARMIN_PRODUCT_NAMES[prodId]) {
      product = GARMIN_PRODUCT_NAMES[prodId];
    } else if (descriptor) {
      product = descriptor;
    } else if (prodName) {
      product = prodName;
    }
    var session = meta.sessions.length ? meta.sessions[0] : {};
    return {
      manufacturerId: mfgId !== undefined ? mfgId : null,
      manufacturer: mfgId !== undefined ? (MANUFACTURER_NAMES[mfgId] || null) : null,
      productId: prodId !== undefined ? prodId : null,
      product: product,
      sport: session.sport !== undefined ? (SPORT_NAMES[session.sport] || ('Sport #' + session.sport)) : null,
      subSport: session.subSport !== undefined ? (SUB_SPORT_NAMES[session.subSport] || ('Sub-sport #' + session.subSport)) : null,
      hasGps: meta.hasGps
    };
  }

  function parseSection(dv, start, end, records, sports, subSports, meta) {
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

      if (def.globalNum === MESG_RECORD || def.globalNum === MESG_SESSION ||
          def.globalNum === MESG_FILE_ID || def.globalNum === MESG_DEVICE_INFO) {
        var values = {};
        var fo = offset;
        for (var k = 0; k < def.fields.length; k++) {
          var f = def.fields[k];
          var bt = BASE_TYPES[f.baseType & 0x9F];
          // Only decode scalars of known base types; always advance by size.
          if (bt && f.size === bt.size) {
            var v = bt.read(dv, fo, def.littleEndian);
            if (bt.invalid === null || v !== bt.invalid) values[f.num] = v;
          } else if ((f.baseType & 0x9F) === 0x07 && f.size > 1) {
            var str = readString(dv, fo, f.size);
            if (str) values[f.num] = str;
          }
          fo += f.size;
        }
        if (def.globalNum === MESG_RECORD) {
          // position_lat (0) / position_long (1): any valid fix means real GPS.
          if (values[0] !== undefined || values[1] !== undefined) meta.hasGps = true;
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
        } else if (def.globalNum === MESG_SESSION) {
          if (values[253] !== undefined) lastTimestamp = values[253];
          if (values[5] !== undefined) {
            sports.push(SPORT_NAMES[values[5]] || ('Sport #' + values[5]));
          }
          if (values[6] !== undefined) {
            subSports.push(SUB_SPORT_NAMES[values[6]] || ('Sub-sport #' + values[6]));
          }
          meta.sessions.push({ sport: values[5], subSport: values[6] });
        } else if (def.globalNum === MESG_FILE_ID) {
          meta.fileIds.push({
            type: values[0], manufacturer: values[1], product: values[2],
            timeCreated: values[4], productName: values[8]
          });
        } else { // device_info
          if (meta.deviceInfos.length < 20 &&
              (values[2] !== undefined || values[27] !== undefined || values[19] !== undefined)) {
            meta.deviceInfos.push({
              manufacturer: values[2], product: values[4], sourceType: values[25],
              descriptor: values[19], productName: values[27]
            });
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

  function readString(dv, offset, size) {
    var bytes = [];
    for (var i = 0; i < size; i++) {
      var b = dv.getUint8(offset + i);
      if (b === 0) break;
      bytes.push(b);
    }
    if (!bytes.length) return null;
    try {
      return new TextDecoder('utf-8').decode(new Uint8Array(bytes)).trim() || null;
    } catch (e) {
      return null;
    }
  }

  var api = { parseFit: parseFit, FIT_EPOCH_OFFSET: FIT_EPOCH_OFFSET };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ATV = global.ATV || {};
  global.ATV.fit = api;
})(typeof window !== 'undefined' ? window : globalThis);
