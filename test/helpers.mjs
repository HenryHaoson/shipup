import { Buffer } from "node:buffer";

function uint16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

/** Build a one-entry, stored ZIP fixture. The reader under test does not verify CRC. */
export function storedZip(name, content) {
  const fileName = Buffer.from(name, "utf8");
  const data = Buffer.from(content);
  const local = Buffer.concat([
    uint32(0x04034b50), uint16(20), uint16(0), uint16(0),
    uint16(0), uint16(0), uint32(0), uint32(data.length), uint32(data.length),
    uint16(fileName.length), uint16(0), fileName, data,
  ]);
  const central = Buffer.concat([
    uint32(0x02014b50), uint16(20), uint16(20), uint16(0), uint16(0),
    uint16(0), uint16(0), uint32(0), uint32(data.length), uint32(data.length),
    uint16(fileName.length), uint16(0), uint16(0), uint16(0), uint16(0),
    uint32(0), uint32(0), fileName,
  ]);
  const end = Buffer.concat([
    uint32(0x06054b50), uint16(0), uint16(0), uint16(1), uint16(1),
    uint32(central.length), uint32(local.length), uint16(0),
  ]);
  return Buffer.concat([local, central, end]);
}
