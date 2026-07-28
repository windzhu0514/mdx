import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const iconPath = join(rootDir, "src-tauri", "icons", "icon.ico");

const size = 32;
const bytesPerPixel = 4;
const pixelDataSize = size * size * bytesPerPixel;
const xorBitmapSize = 40 + pixelDataSize;
const andMaskSize = Math.ceil(size / 32) * 4 * size;
const imageSize = xorBitmapSize + andMaskSize;
const iconDirSize = 6;
const iconDirEntrySize = 16;
const imageOffset = iconDirSize + iconDirEntrySize;
const fileSize = imageOffset + imageSize;

const buffer = Buffer.alloc(fileSize);
let offset = 0;

buffer.writeUInt16LE(0, offset);
offset += 2;
buffer.writeUInt16LE(1, offset);
offset += 2;
buffer.writeUInt16LE(1, offset);
offset += 2;

buffer.writeUInt8(size, offset);
offset += 1;
buffer.writeUInt8(size, offset);
offset += 1;
buffer.writeUInt8(0, offset);
offset += 1;
buffer.writeUInt8(0, offset);
offset += 1;
buffer.writeUInt16LE(1, offset);
offset += 2;
buffer.writeUInt16LE(32, offset);
offset += 2;
buffer.writeUInt32LE(imageSize, offset);
offset += 4;
buffer.writeUInt32LE(imageOffset, offset);
offset += 4;

buffer.writeUInt32LE(40, offset);
offset += 4;
buffer.writeInt32LE(size, offset);
offset += 4;
buffer.writeInt32LE(size * 2, offset);
offset += 4;
buffer.writeUInt16LE(1, offset);
offset += 2;
buffer.writeUInt16LE(32, offset);
offset += 2;
buffer.writeUInt32LE(0, offset);
offset += 4;
buffer.writeUInt32LE(pixelDataSize, offset);
offset += 4;
buffer.writeInt32LE(0, offset);
offset += 4;
buffer.writeInt32LE(0, offset);
offset += 4;
buffer.writeUInt32LE(0, offset);
offset += 4;
buffer.writeUInt32LE(0, offset);
offset += 4;

for (let y = size - 1; y >= 0; y -= 1) {
    for (let x = 0; x < size; x += 1) {
        const dx = x - size / 2 + 0.5;
        const dy = y - size / 2 + 0.5;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const inside = distance <= 14;
        const edge = distance > 12 && distance <= 14;
        const letter =
            x >= 9 &&
            x <= 23 &&
            y >= 8 &&
            y <= 23 &&
            (x <= 12 || x >= 20 || Math.abs(x - y) <= 1 || Math.abs(x + y - 31) <= 1);

        let r = 47;
        let g = 111;
        let b = 237;
        let a = inside ? 255 : 0;

        if (edge) {
            r = 111;
            g = 140;
            b = 255;
        }

        if (letter) {
            r = 255;
            g = 255;
            b = 255;
            a = 255;
        }

        buffer.writeUInt8(b, offset);
        offset += 1;
        buffer.writeUInt8(g, offset);
        offset += 1;
        buffer.writeUInt8(r, offset);
        offset += 1;
        buffer.writeUInt8(a, offset);
        offset += 1;
    }
}

mkdirSync(dirname(iconPath), { recursive: true });
writeFileSync(iconPath, buffer);
console.log(`Generated ${iconPath}`);
