import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sharp = require('sharp') as any;
import { buildImageVariants } from './image-variants';

describe('multi-scale image variants', () => {
  it('creates one full-page image and three overlapping detail crops', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'partscan-variants-'));
    const path = join(directory, 'page.jpg');
    try {
      await sharp({ create: { width: 900, height: 1200, channels: 3, background: 'white' } }).jpeg().toFile(path);
      const variants = await buildImageVariants(path, true);
      expect(variants.map((item) => item.label)).toEqual(['完整页', '高清局部1/3', '高清局部2/3', '高清局部3/3']);
      expect(variants.every((item) => item.dataUrl.startsWith('data:image/jpeg;base64,'))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
