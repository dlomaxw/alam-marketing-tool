/**
 * Produces the email- and UI-ready logo assets from the supplied masters.
 *
 * Masters are large and heavily padded; mail clients downscale badly and
 * render alpha inconsistently, so each asset is trimmed of its surrounding
 * whitespace, flattened onto the exact background it sits on, and emitted at
 * 2x its display width.
 */
import sharp from "sharp";
import { stat } from "node:fs/promises";

interface Job {
  src: string;
  out: string;
  width: number;
  /** Background the asset is composited onto, matching where it renders. */
  background: string;
  trim: boolean;
}

const JOBS: Job[] = [
  // Header, on white.
  { src: "brand/alam-business-center-master.png", out: "public/alam-logo.png", width: 360, background: "#FFFFFF", trim: false },
  { src: "brand/alam-business-center-master.png", out: "public/alam-logo-sm.png", width: 120, background: "#FFFFFF", trim: false },
  // Footer credit, on the footer's #FAFAFA.
  { src: "public/bright-properties-logo.png", out: "public/bright-logo.png", width: 280, background: "#FAFAFA", trim: true },
  { src: "public/bright-properties-logo.png", out: "public/bright-logo-sm.png", width: 120, background: "#FFFFFF", trim: true },
];

for (const job of JOBS) {
  try {
    await stat(job.src);
  } catch {
    console.log(`skip (master missing): ${job.src}`);
    continue;
  }

  let pipeline = sharp(job.src);
  // Trim first, then resize: otherwise the padding is what gets scaled.
  if (job.trim) pipeline = pipeline.trim({ threshold: 10 });

  await pipeline
    .flatten({ background: job.background })
    .resize({ width: job.width, withoutEnlargement: true })
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toFile(job.out);

  const s = await stat(job.out);
  const meta = await sharp(job.out).metadata();
  console.log(`${job.out.padEnd(30)} ${meta.width}x${meta.height}  ${(s.size / 1024).toFixed(1)} KB`);
}

/*
 * Building renders for the email hero (section 6.1: "compressed and
 * accessible"). JPEG rather than PNG: these are photographic, and the PNGs are
 * ~2 MB each, which would hurt deliverability and load badly on a Ugandan
 * mobile connection. Emitted at 2x the 620px container for retina.
 */
const HERO_JOBS = [
  { src: "brand/building-a1-master.png", out: "public/building-street.jpg" },
  { src: "brand/building-a2-master.png", out: "public/building-entrance.jpg" },
];

for (const job of HERO_JOBS) {
  try {
    await stat(job.src);
  } catch {
    console.log(`skip (master missing): ${job.src}`);
    continue;
  }
  await sharp(job.src)
    .resize({ width: 1240, withoutEnlargement: true })
    .jpeg({ quality: 78, progressive: true, mozjpeg: true })
    .toFile(job.out);

  const s = await stat(job.out);
  const meta = await sharp(job.out).metadata();
  console.log(`${job.out.padEnd(30)} ${meta.width}x${meta.height}  ${(s.size / 1024).toFixed(1)} KB`);
}
