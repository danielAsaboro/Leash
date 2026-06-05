import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  getLeashIconSvgMarkup,
  LEASH_MARK_CUTOUT,
  LEASH_MARK_LINKS,
  LEASH_MARK_NODES,
  LEASH_MARK_STROKE,
  LEASH_MARK_TILE_RADIUS,
  LEASH_MARK_VIEWBOX,
} from "../lib/brand/leash-mark.ts";

const OUTPUTS = [
  { path: "public/favicon-16x16.png", size: 16 },
  { path: "public/favicon-32x32.png", size: 32 },
  { path: "public/apple-touch-icon.png", size: 180 },
  { path: "public/icon-192.png", size: 192 },
  { path: "public/icon-512.png", size: 512 },
] as const;

const SVG_OUTPUT = "public/brand/leash-mark.svg";
const ICO_OUTPUT = "public/favicon.ico";

const TILE = hexToRgba("#f1efe6");
const MARK = hexToRgba("#191712");

function main() {
  const root = resolve(import.meta.dirname, "..");
  const svgPath = resolve(root, SVG_OUTPUT);
  mkdirSync(dirname(svgPath), { recursive: true });
  writeFileSync(svgPath, `${getLeashIconSvgMarkup()}\n`);

  const pngs = OUTPUTS.map(({ path, size }) => {
    const png = encodePng(rasterize(size));
    const target = resolve(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, png);
    return { size, png };
  });

  const icoPath = resolve(root, ICO_OUTPUT);
  writeFileSync(
    icoPath,
    encodeIco(
      pngs
        .filter(({ size }) => size === 16 || size === 32)
        .map(({ size, png }) => ({ size, png })),
    ),
  );
}

function rasterize(size: number) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = size / LEASH_MARK_VIEWBOX;
  const sampleOffsets = [0.125, 0.375, 0.625, 0.875];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let tileCoverage = 0;
      let markCoverage = 0;
      let cutoutCoverage = 0;

      for (const oy of sampleOffsets) {
        for (const ox of sampleOffsets) {
          const px = (x + ox) / scale;
          const py = (y + oy) / scale;

          if (isInsideRoundedRect(px, py, LEASH_MARK_VIEWBOX, LEASH_MARK_VIEWBOX, LEASH_MARK_TILE_RADIUS)) {
            tileCoverage += 1;
          }
          if (isInsideMark(px, py)) {
            markCoverage += 1;
          }
          if (isInsideCircle(px, py, LEASH_MARK_CUTOUT.cx, LEASH_MARK_CUTOUT.cy, LEASH_MARK_CUTOUT.r)) {
            cutoutCoverage += 1;
          }
        }
      }

      const coverageScale = sampleOffsets.length ** 2;
      const pixel = blendLayers(
        [
          { color: TILE, alpha: tileCoverage / coverageScale },
          { color: MARK, alpha: markCoverage / coverageScale },
          { color: TILE, alpha: cutoutCoverage / coverageScale },
        ],
        [0, 0, 0, 0],
      );

      const offset = (y * size + x) * 4;
      pixels[offset] = pixel[0];
      pixels[offset + 1] = pixel[1];
      pixels[offset + 2] = pixel[2];
      pixels[offset + 3] = pixel[3];
    }
  }

  return { size, pixels };
}

function isInsideMark(x: number, y: number) {
  if (LEASH_MARK_NODES.some((node) => isInsideCircle(x, y, node.cx, node.cy, node.r))) {
    return true;
  }

  return LEASH_MARK_LINKS.some((link) =>
    distanceToSegment(x, y, link.x1, link.y1, link.x2, link.y2) <= LEASH_MARK_STROKE / 2,
  );
}

function isInsideCircle(x: number, y: number, cx: number, cy: number, r: number) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function isInsideRoundedRect(x: number, y: number, width: number, height: number, radius: number) {
  if (x < 0 || y < 0 || x > width || y > height) {
    return false;
  }

  const innerX = Math.max(radius, Math.min(x, width - radius));
  const innerY = Math.max(radius, Math.min(y, height - radius));
  const dx = x - innerX;
  const dy = y - innerY;
  return dx * dx + dy * dy <= radius * radius;
}

function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  const distX = px - projX;
  const distY = py - projY;
  return Math.sqrt(distX * distX + distY * distY);
}

function blendLayers(
  layers: Array<{ color: [number, number, number, number]; alpha: number }>,
  base: [number, number, number, number],
) {
  let [r, g, b, a] = base.map((value) => value / 255);

  for (const layer of layers) {
    if (layer.alpha <= 0) {
      continue;
    }

    const [lr, lg, lb, laRaw] = layer.color.map((value) => value / 255) as [number, number, number, number];
    const la = laRaw * layer.alpha;
    const outA = la + a * (1 - la);

    if (outA === 0) {
      continue;
    }

    r = (lr * la + r * a * (1 - la)) / outA;
    g = (lg * la + g * a * (1 - la)) / outA;
    b = (lb * la + b * a * (1 - la)) / outA;
    a = outA;
  }

  return [r, g, b, a].map((value) => Math.round(value * 255)) as [number, number, number, number];
}

function encodePng({ size, pixels }: { size: number; pixels: Buffer }) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(size * (size * 4 + 1));

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    header[rowStart] = 0;
    pixels.copy(header, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    signature,
    pngChunk("IHDR", (() => {
      const data = Buffer.alloc(13);
      data.writeUInt32BE(size, 0);
      data.writeUInt32BE(size, 4);
      data[8] = 8;
      data[9] = 6;
      data[10] = 0;
      data[11] = 0;
      data[12] = 0;
      return data;
    })()),
    pngChunk("IDAT", deflateSync(header)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(entries: Array<{ size: number; png: Buffer }>) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const directory = Buffer.alloc(entries.length * 16);
  const payloads: Buffer[] = [];

  entries.forEach(({ size, png }, index) => {
    const dirOffset = index * 16;
    directory[dirOffset] = size === 256 ? 0 : size;
    directory[dirOffset + 1] = size === 256 ? 0 : size;
    directory[dirOffset + 2] = 0;
    directory[dirOffset + 3] = 0;
    directory.writeUInt16LE(1, dirOffset + 4);
    directory.writeUInt16LE(32, dirOffset + 6);
    directory.writeUInt32LE(png.length, dirOffset + 8);
    directory.writeUInt32LE(offset, dirOffset + 12);
    payloads.push(png);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...payloads]);
}

function pngChunk(type: string, data: Buffer) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hexToRgba(hex: string): [number, number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
    255,
  ];
}

main();
