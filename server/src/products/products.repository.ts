import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PartsList, ProductRecord } from '../domain';

@Injectable()
export class ProductsRepository {
  private readonly products = new Map<string, ProductRecord>();

  create(name: string, coverPath?: string): ProductRecord {
    const now = new Date().toISOString();
    const product: ProductRecord = { id: randomUUID(), name, coverPath, manualPagePaths: [], createdAt: now, updatedAt: now };
    this.products.set(product.id, product);
    return product;
  }

  list(): ProductRecord[] {
    return [...this.products.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): ProductRecord {
    const product = this.products.get(id);
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  addManualPages(id: string, paths: string[]): ProductRecord {
    const product = this.get(id);
    product.manualPagePaths.push(...paths);
    product.updatedAt = new Date().toISOString();
    return product;
  }

  setAnalysis(id: string, analysisId: string): void {
    const product = this.get(id);
    product.activeAnalysisId = analysisId;
    product.updatedAt = new Date().toISOString();
  }

  setPartsList(id: string, partsList: PartsList): void {
    const product = this.get(id);
    product.partsList = partsList;
    product.updatedAt = new Date().toISOString();
  }

  clearManualPaths(id: string): void {
    const product = this.get(id);
    product.manualPagePaths = [];
    product.updatedAt = new Date().toISOString();
  }

  clearManualPathsIfPresent(id: string): void {
    const product = this.products.get(id);
    if (product) {
      product.manualPagePaths = [];
      product.updatedAt = new Date().toISOString();
    }
  }
}
