import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ManualPageCaptureHint, ProductRecord } from '../domain';
import { ProductsRepository } from './products.repository';
import { StorageService } from './storage.service';

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);
  constructor(private readonly repository: ProductsRepository, private readonly storage: StorageService) {}

  async create(name: string, cover?: Express.Multer.File) {
    const product = this.repository.create(name.trim());
    if (cover) product.coverPath = await this.storage.saveCover(product.id, cover);
    this.logger.log(`产品已创建 productId=${product.id} name=${JSON.stringify(product.name)} hasCover=${Boolean(cover)}`);
    return this.publicProduct(product);
  }

  list() { return this.repository.list().map((product) => this.publicProduct(product)); }
  get(id: string) { return this.publicProduct(this.repository.get(id)); }
  getCoverPath(id: string) {
    const path = this.repository.get(id).coverPath;
    if (!path) throw new BadRequestException('This product has no cover');
    return path;
  }

  async addPages(id: string, files: Express.Multer.File[], rawHints?: string) {
    if (!files.length) throw new BadRequestException('At least one manual page is required');
    const product = this.repository.get(id);
    const maximum = Number(process.env.MAX_MANUAL_PAGES ?? 80);
    if (product.manualPagePaths.length + files.length > maximum) throw new BadRequestException(`A manual can contain at most ${maximum} cached pages`);
    const paths = await this.storage.saveManualPages(id, files);
    const hints = this.parseCaptureHints(rawHints, files.length);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    this.logger.log(`说明书已上传 productId=${id} pages=${files.length} bytes=${totalBytes} hints=${JSON.stringify(hints)}`);
    return this.publicProduct(this.repository.addManualPages(id, paths, hints));
  }

  async clearManualCache(id: string) {
    this.repository.get(id);
    await this.storage.clearManualPages(id);
    this.repository.clearManualPaths(id);
    this.logger.log(`说明书缓存已主动清理 productId=${id}`);
    return { productId: id, cleared: true };
  }

  private publicProduct(product: ProductRecord) {
    return {
      id: product.id,
      name: product.name,
      hasCover: Boolean(product.coverPath),
      manualPageCount: product.manualPagePaths.length,
      activeAnalysisId: product.activeAnalysisId,
      hasPartsList: Boolean(product.partsList),
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  }

  private parseCaptureHints(raw: string | undefined, count: number): ManualPageCaptureHint[] {
    if (!raw) return Array(count).fill('unknown') as ManualPageCaptureHint[];
    try {
      const values = JSON.parse(raw) as unknown;
      if (!Array.isArray(values) || values.length !== count) throw new Error('count mismatch');
      return values.map((value): ManualPageCaptureHint =>
        value === 'plate_catalog' || value === 'assembly_steps' ? value : 'unknown');
    } catch {
      throw new BadRequestException('captureHints must be a JSON array aligned with uploaded pages');
    }
  }
}
