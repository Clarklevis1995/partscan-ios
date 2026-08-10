import { Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
// Sharp 0.35 exposes a CommonJS callable while its conditional type export is
// interpreted as an ES module by this project's NodeNext-aware dependencies.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp') as any;

export interface ImageVariant { label: string; dataUrl: string }

const logger = new Logger('ImageVariants');

export async function buildImageVariants(path: string, multiScale: boolean): Promise<ImageVariant[]> {
  const original = await readFile(path);
  if (!multiScale) return [{ label: '完整页', dataUrl: dataUrl(original, mime(path)) }];
  try {
    const normalized = await sharp(original).rotate().jpeg({ quality: 92, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    const variants: ImageVariant[] = [{ label: '完整页', dataUrl: dataUrl(normalized.data, 'image/jpeg') }];
    const segment = Math.ceil(normalized.info.height / 3);
    const overlap = Math.ceil(segment * 0.12);
    for (let index = 0; index < 3; index++) {
      const top = Math.max(0, index * segment - (index ? overlap : 0));
      const bottom = Math.min(normalized.info.height, (index + 1) * segment + (index < 2 ? overlap : 0));
      const crop = await sharp(normalized.data)
        .extract({ left: 0, top, width: normalized.info.width, height: bottom - top })
        .sharpen({ sigma: 0.8 })
        .jpeg({ quality: 94, mozjpeg: true })
        .toBuffer();
      variants.push({ label: `高清局部${index + 1}/3`, dataUrl: dataUrl(crop, 'image/jpeg') });
    }
    return variants;
  } catch (error) {
    logger.warn(`多尺度裁剪失败 path=${path}: ${error instanceof Error ? error.message : 'unknown'}; 使用完整原图`);
    return [{ label: '完整页', dataUrl: dataUrl(original, mime(path)) }];
  }
}

function dataUrl(data: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

function mime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.heic': return 'image/heic';
    default: return 'image/jpeg';
  }
}
