import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const [, , inputPathArg, outputSvgArg, keyHexArg = "ff00ff"] = process.argv;

if (!inputPathArg || !outputSvgArg) {
  throw new Error("Usage: node scripts/png_key_to_svg.mjs <input.png> <output.svg> [keyHex]");
}

const inputPath = path.resolve(inputPathArg);
const outputSvgPath = path.resolve(outputSvgArg);
const keyHex = keyHexArg.replace("#", "").trim().toLowerCase();

if (!/^[0-9a-f]{6}$/.test(keyHex)) {
  throw new Error(`Expected 6-digit key color, got ${keyHexArg}`);
}

const keyColor = {
  r: Number.parseInt(keyHex.slice(0, 2), 16),
  g: Number.parseInt(keyHex.slice(2, 4), 16),
  b: Number.parseInt(keyHex.slice(4, 6), 16),
};

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePngRgba(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Invalid PNG signature");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatParts = [];

  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    offset += 4;
    const type = buffer.toString("ascii", offset, offset + 4);
    offset += 4;
    const data = buffer.subarray(offset, offset + length);
    offset += length;
    const _crc = buffer.readUInt32BE(offset);
    offset += 4;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8 || colorType !== 6) {
        throw new Error(`Unsupported PNG format bitDepth=${bitDepth} colorType=${colorType}`);
      }
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  const inflated = zlib.inflateSync(Buffer.concat(idatParts));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(width * height * bytesPerPixel);

  let inOffset = 0;
  let outOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filterType = inflated[inOffset];
    inOffset += 1;

    for (let column = 0; column < stride; column += 1) {
      const raw = inflated[inOffset];
      inOffset += 1;

      const left = column >= bytesPerPixel ? pixels[outOffset + column - bytesPerPixel] : 0;
      const up = row > 0 ? pixels[outOffset + column - stride] : 0;
      const upLeft = row > 0 && column >= bytesPerPixel ? pixels[outOffset + column - stride - bytesPerPixel] : 0;

      let value = raw;
      if (filterType === 1) value = (raw + left) & 0xff;
      else if (filterType === 2) value = (raw + up) & 0xff;
      else if (filterType === 3) value = (raw + Math.floor((left + up) / 2)) & 0xff;
      else if (filterType === 4) value = (raw + paethPredictor(left, up, upLeft)) & 0xff;
      else if (filterType !== 0) throw new Error(`Unsupported PNG filter type ${filterType}`);

      pixels[outOffset + column] = value;
    }

    outOffset += stride;
  }

  return { width, height, pixels };
}

function encodePngRgba({ width, height, pixels }) {
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const scanlines = Buffer.alloc((stride + 1) * height);

  for (let row = 0; row < height; row += 1) {
    const inOffset = row * stride;
    const outOffset = row * (stride + 1);
    scanlines[outOffset] = 0;
    pixels.copy(scanlines, outOffset + 1, inOffset, inOffset + stride);
  }

  const compressed = zlib.deflateSync(scanlines, { level: 9 });

  const chunks = [];
  const pushChunk = (type, data) => {
    const typeBuffer = Buffer.from(type, "ascii");
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(data.length, 0);
    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    chunks.push(lengthBuffer, typeBuffer, data, crcBuffer);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  pushChunk("IHDR", ihdr);
  pushChunk("IDAT", compressed);
  pushChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([PNG_SIGNATURE, ...chunks]);
}

const decoded = decodePngRgba(fs.readFileSync(inputPath));
let transparentPixels = 0;
for (let offset = 0; offset < decoded.pixels.length; offset += 4) {
  if (
    decoded.pixels[offset] === keyColor.r &&
    decoded.pixels[offset + 1] === keyColor.g &&
    decoded.pixels[offset + 2] === keyColor.b
  ) {
    decoded.pixels[offset + 3] = 0;
    transparentPixels += 1;
  }
}

const cleanedPng = encodePngRgba(decoded);
const base64 = cleanedPng.toString("base64");
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${decoded.width}" height="${decoded.height}" viewBox="0 0 ${decoded.width} ${decoded.height}" role="img" aria-labelledby="title desc">
  <title id="title">Nordic Seas bathymetry render</title>
  <desc id="desc">Embedded PNG render with color-keyed transparency removed from ${path.basename(inputPath)} using key #${keyHex}. Transparent pixels: ${transparentPixels}.</desc>
  <image width="${decoded.width}" height="${decoded.height}" href="data:image/png;base64,${base64}"/>
</svg>
`;

fs.mkdirSync(path.dirname(outputSvgPath), { recursive: true });
fs.writeFileSync(outputSvgPath, svg);

console.log(`Saved ${outputSvgPath}`);
console.log(`Size ${decoded.width}x${decoded.height}`);
console.log(`Transparent pixels ${transparentPixels}`);
