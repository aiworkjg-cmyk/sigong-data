import { deflateSync } from 'node:zlib';

/** CRC-32 used by PNG chunks. Kept here to avoid adding an image dependency. */
function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(name: 'IHDR' | 'IDAT' | 'IEND', data: Buffer): Buffer {
  const type = Buffer.from(name, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

/** Creates a small, valid PNG so the test exercises a real binary upload. */
export function createConnectionTestPng(): Buffer {
  const width = 320;
  const height = 120;
  const bytesPerPixel = 4;
  const rows = Buffer.alloc((width * bytesPerPixel + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * bytesPerPixel + 1);
    rows[rowStart] = 0; // PNG filter: none
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * bytesPerPixel;
      const stripe = Math.floor(x / 32) % 2 === Math.floor(y / 24) % 2;
      rows[offset] = stripe ? 37 : 16;
      rows[offset + 1] = stripe ? 99 : 185;
      rows[offset + 2] = stripe ? 235 : 129;
      rows[offset + 3] = 255;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
