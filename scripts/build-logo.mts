/**
 * One-off: produce the email- and UI-ready ALAM logo from the supplied master.
 *
 * The master is 1626x967 and 776 KB, which is far too heavy for an email
 * header and would be downscaled badly by mail clients. This emits a 2x asset
 * for a 180 px display width, and a small UI mark.
 */
import sharp from "sharp";
import { stat } from "node:fs/promises";

const SRC = "public/Alam business center.png";

async function emit(out: string, width: number) {
  await sharp(SRC)
    .resize({ width, withoutEnlargement: true })
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toFile(out);
  const s = await stat(out);
  const meta = await sharp(out).metadata();
  console.log(`${out.padEnd(34)} ${meta.width}x${meta.height}  ${(s.size / 1024).toFixed(1)} KB`);
}

const before = await stat(SRC);
console.log(`source: ${(before.size / 1024).toFixed(1)} KB`);
await emit("public/alam-logo.png", 360);
await emit("public/alam-logo-sm.png", 120);
