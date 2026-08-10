import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = resolve(config.get('STORAGE_DIR', './storage'));
  }

  async onModuleInit() { await mkdir(this.root, { recursive: true }); }

  async saveCover(productId: string, file: Express.Multer.File): Promise<string> {
    return this.save(productId, 'cover', file);
  }

  async saveManualPages(productId: string, files: Express.Multer.File[]): Promise<string[]> {
    return Promise.all(files.map((file) => this.save(productId, 'manual', file)));
  }

  async clearManualPages(productId: string): Promise<void> {
    const directory = this.safePath(productId, 'manual');
    await rm(directory, { recursive: true, force: true });
  }

  private async save(productId: string, category: 'cover' | 'manual', file: Express.Multer.File): Promise<string> {
    if (!file.mimetype.startsWith('image/')) throw new BadRequestException('Only image uploads are accepted');
    const directory = this.safePath(productId, category);
    await mkdir(directory, { recursive: true });
    const extension = this.extensionFor(file.mimetype);
    const path = resolve(directory, `${randomUUID()}${extension}`);
    if (!path.startsWith(`${directory}${sep}`)) throw new BadRequestException('Invalid file path');
    await writeFile(path, file.buffer);
    return path;
  }

  private extensionFor(mime: string): string {
    const extensions: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif' };
    const extension = extensions[mime.toLowerCase()];
    if (!extension) throw new BadRequestException('Supported formats: JPEG, PNG, WebP, HEIC, HEIF');
    return extension;
  }

  private safePath(productId: string, category: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(productId)) throw new BadRequestException('Invalid product id');
    const path = resolve(this.root, 'products', productId, category);
    if (!path.startsWith(`${this.root}${sep}`)) throw new BadRequestException('Invalid storage path');
    return path;
  }
}
