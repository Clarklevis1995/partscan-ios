import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ImportBandaiManualsDto } from './dto/import-bandai-manuals.dto';

const BASE_URL = 'https://manual.bandai-hobby.net/';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150.0 Safari/537.36 PartScanBandaiManualDownloader/1.0';

export interface BandaiManual {
  manualId: string;
  title: string;
  titleEn: string;
  productNumber: string;
  releaseDate: string;
  brand: string;
  work: string;
  detailUrl: string;
  pdfUrl: string;
  coverUrl: string;
  productDir: string;
  coverFile: string;
  pdfFile: string;
  status: 'discovered' | 'downloaded' | 'exists' | 'failed';
  error: string;
}

@Injectable()
export class BandaiManualsService {
  private readonly logger = new Logger(BandaiManualsService.name);
  private readonly root: string;
  private lastRequestAt = 0;

  constructor(config: ConfigService) {
    this.root = resolve(config.get('STORAGE_DIR', './storage'), 'bandai-manuals');
  }

  async import(options: ImportBandaiManualsDto) {
    if (options.endPage < options.startPage) throw new BadRequestException('endPage must be greater than or equal to startPage');
    const startedAt = Date.now();
    const query = options.query.trim() || options.freeword.trim();
    this.logger.log(`Import started query=${JSON.stringify(query)} pages=${options.startPage}-${options.endPage} limit=${options.limit} overwrite=${options.overwrite}`);
    await mkdir(this.root, { recursive: true });
    const manuals = await this.discover(options);
    this.logger.log(`Discovery completed products=${manuals.length}`);

    for (const manual of manuals) {
      const manualStartedAt = Date.now();
      this.logger.log(`Product processing started manualId=${manual.manualId} title=${JSON.stringify(manual.title)}`);
      try {
        const detailHtml = await this.fetchText(manual.detailUrl, options.delayMs);
        this.applyDetails(manual, detailHtml);
        const productDir = join(this.root, this.productDirectoryName(manual));
        manual.productDir = productDir;
        await mkdir(productDir, { recursive: true });

        manual.coverFile = await this.downloadCover(manual, options);
        manual.pdfFile = await this.downloadPdf(manual, options);
        manual.status = 'downloaded';
        this.logger.log(`Product processing completed manualId=${manual.manualId} status=${manual.status} durationMs=${Date.now() - manualStartedAt}`);
      } catch (error) {
        manual.status = 'failed';
        manual.error = error instanceof Error ? error.message : String(error);
        this.logger.error(`Product processing failed manualId=${manual.manualId} durationMs=${Date.now() - manualStartedAt} error=${manual.error}`, error instanceof Error ? error.stack : undefined);
      }
      await this.writeProductInfo(manual);
      await this.writeManifest(manuals);
    }

    const failed = manuals.filter((manual) => manual.status === 'failed').length;
    this.logger.log(`Import completed requested=${manuals.length} succeeded=${manuals.length - failed} failed=${failed} durationMs=${Date.now() - startedAt}`);
    return {
      outputDirectory: this.root,
      requested: manuals.length,
      succeeded: manuals.length - failed,
      failed,
      manuals,
    };
  }

  async discover(options: ImportBandaiManualsDto): Promise<BandaiManual[]> {
    const manuals = new Map<string, BandaiManual>();
    for (let page = options.startPage; page <= options.endPage; page += 1) {
      const url = new URL(BASE_URL);
      url.searchParams.set('page', String(page));
      url.searchParams.set('sort', options.sort);
      const query = options.query.trim() || options.freeword.trim();
      if (query) url.searchParams.set('freeword', query);
      const items = parseListPage(await this.fetchText(url.toString(), options.delayMs));
      this.logger.log(`Discovery page parsed page=${page} products=${items.length} accumulated=${manuals.size}`);
      const before = manuals.size;
      for (const item of items) {
        if (!manuals.has(item.manualId)) manuals.set(item.manualId, item);
        if (manuals.size >= options.limit) return [...manuals.values()];
      }
      if (!items.length || manuals.size === before) break;
    }
    return [...manuals.values()];
  }

  private applyDetails(manual: BandaiManual, html: string): void {
    const title = firstMatch(html, /<h2[^>]*>([\s\S]*?)<\/h2>/i);
    manual.title = cleanText(title) || manual.title;
    manual.productNumber = definitionValue(html, '品番') || manual.productNumber;
    manual.releaseDate = definitionValue(html, '発売日') || manual.releaseDate;
    manual.brand = definitionValue(html, 'ブランド');
    manual.work = definitionValue(html, '作品');
    const decoded = decodeHtml(html);
    const pdfPath = firstMatch(decoded, /(?:viewer\.php\?[^"']*?file=)?(\/pdf\/[^"'&?]+\.pdf)/i);
    manual.pdfUrl = new URL(pdfPath || `/pdf/${manual.manualId}.pdf`, BASE_URL).toString();
  }

  private async downloadCover(manual: BandaiManual, options: ImportBandaiManualsDto): Promise<string> {
    this.logger.log(`Cover download started manualId=${manual.manualId} url=${manual.coverUrl}`);
    const response = await this.fetchResponse(manual.coverUrl, options.delayMs, { Accept: 'image/*', Referer: manual.detailUrl });
    const contentType = response.headers.get('content-type')?.split(';')[0] ?? '';
    if (!contentType.startsWith('image/')) throw new Error(`Unexpected cover content type: ${contentType || 'missing'}`);
    const extensions: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
    const extension = extensions[contentType] ?? (extname(new URL(manual.coverUrl).pathname) || '.img');
    const destination = join(manual.productDir, `cover${extension}`);
    await this.downloadResponse(response, destination, options.overwrite);
    this.logger.log(`Cover download completed manualId=${manual.manualId} bytes=${await fileSize(destination)} path=${destination}`);
    return destination;
  }

  private async downloadPdf(manual: BandaiManual, options: ImportBandaiManualsDto): Promise<string> {
    const destination = join(manual.productDir, 'manual.pdf');
    if (!options.overwrite && await hasSignature(destination, Buffer.from('%PDF-'))) {
      this.logger.log(`PDF download skipped manualId=${manual.manualId} reason=exists bytes=${await fileSize(destination)} path=${destination}`);
      return destination;
    }
    const partial = `${destination}.part`;
    const offset = options.overwrite ? 0 : await fileSize(partial);
    const headers: Record<string, string> = { Accept: 'application/pdf', Referer: manual.detailUrl };
    if (offset) headers.Range = `bytes=${offset}-`;
    this.logger.log(`PDF download started manualId=${manual.manualId} url=${manual.pdfUrl} resumeBytes=${offset}`);
    const response = await this.fetchResponse(manual.pdfUrl, options.delayMs, headers);
    const contentType = response.headers.get('content-type')?.split(';')[0];
    if (contentType !== 'application/pdf') throw new Error(`Unexpected PDF content type: ${contentType || 'missing'}`);
    await this.streamResponse(response, partial, offset > 0 && response.status === 206);
    if (!await hasSignature(partial, Buffer.from('%PDF-'))) throw new Error('Downloaded file is not a PDF');
    await rename(partial, destination);
    this.logger.log(`PDF download completed manualId=${manual.manualId} bytes=${await fileSize(destination)} path=${destination}`);
    return destination;
  }

  private async fetchText(url: string, delayMs: number): Promise<string> {
    const response = await this.fetchResponse(url, delayMs, { Accept: 'text/html', 'Accept-Language': 'ja,en;q=0.8' });
    return response.text();
  }

  private async fetchResponse(url: string, delayMs: number, headers: Record<string, string>): Promise<Response> {
    const remaining = delayMs - (Date.now() - this.lastRequestAt);
    if (remaining > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, remaining));
    let lastError: unknown;
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      const startedAt = Date.now();
      try {
        this.logger.log(`HTTP request started attempt=${attempt + 1}/4 url=${url}`);
        const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(30_000) });
        this.lastRequestAt = Date.now();
        this.logger.log(`HTTP response received status=${response.status} durationMs=${Date.now() - startedAt} url=${url}`);
        if (response.ok) return response;
        if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === 3) throw new Error(`HTTP ${response.status} for ${url}`);
      } catch (error) {
        lastError = error;
        this.logger.warn(`HTTP request failed attempt=${attempt + 1}/4 durationMs=${Date.now() - startedAt} url=${url} error=${error instanceof Error ? error.message : String(error)}`);
        if (attempt === 3) break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(2 ** attempt * 1000, 10_000)));
    }
    throw lastError instanceof Error ? lastError : new Error(`Failed to fetch ${url}`);
  }

  private async downloadResponse(response: Response, destination: string, overwrite: boolean): Promise<void> {
    if (!overwrite && await existsNonEmpty(destination)) return;
    await this.streamResponse(response, `${destination}.part`, false);
    await rename(`${destination}.part`, destination);
  }

  private async streamResponse(response: Response, path: string, append: boolean): Promise<void> {
    if (!response.body) throw new Error('Response body is empty');
    await pipeline(response.body as never, createWriteStream(path, { flags: append ? 'a' : 'w' }));
  }

  private async writeProductInfo(manual: BandaiManual): Promise<void> {
    if (!manual.productDir) return;
    await mkdir(manual.productDir, { recursive: true });
    await writeFile(join(manual.productDir, 'product-name.txt'), `${manual.title}\n`, 'utf8');
    await writeFile(join(manual.productDir, 'product.json'), `${JSON.stringify(manual, null, 2)}\n`, 'utf8');
  }

  private async writeManifest(manuals: BandaiManual[]): Promise<void> {
    await writeFile(join(this.root, 'manifest.json'), `${JSON.stringify(manuals, null, 2)}\n`, 'utf8');
  }

  private productDirectoryName(manual: BandaiManual): string {
    const title = safeName(manual.title, 'manual');
    const product = manual.productNumber.replace(/[^0-9A-Za-z_-]/g, '');
    return `${manual.manualId}${product ? `_${product}` : ''}_${title}`;
  }
}

export function parseListPage(html: string): BandaiManual[] {
  const manuals = new Map<string, BandaiManual>();
  const links = /<a\b[^>]*href=["']([^"']*\/menus\/detail\/(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(links)) {
    const body = match[3];
    const nameBlock = firstMatch(body, /<div[^>]*class=["'][^"']*\bbl_result_name\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const titleEn = cleanText(firstMatch(nameBlock, /<span[^>]*class=["'][^"']*\bbl_result_name_en\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i));
    const title = cleanText(nameBlock.replace(/<span[\s\S]*?<\/span>/i, ''));
    const cover = firstMatch(body, /<img\b[^>]*src=["']([^"']+)["']/i);
    const manualId = match[2];
    manuals.set(manualId, {
      manualId, title, titleEn, productNumber: '', releaseDate: definitionValue(body, '発売日'), brand: '', work: '',
      detailUrl: new URL(match[1], BASE_URL).toString(), pdfUrl: '', coverUrl: new URL(cover, BASE_URL).toString(),
      productDir: '', coverFile: '', pdfFile: '', status: 'discovered', error: '',
    });
  }
  return [...manuals.values()];
}

export function definitionValue(html: string, term: string): string {
  const definitions = /<dl\b[^>]*>([\s\S]*?)<\/dl>/gi;
  for (const definition of html.matchAll(definitions)) {
    const dt = cleanText(firstMatch(definition[1], /<dt\b[^>]*>([\s\S]*?)<\/dt>/i));
    if (dt === term || dt.startsWith(`${term} `)) {
      return cleanText(firstMatch(definition[1], /<dd\b[^>]*>([\s\S]*?)<\/dd>/i));
    }
  }
  return '';
}

function firstMatch(value: string, pattern: RegExp): string { return value.match(pattern)?.[1] ?? ''; }
function decodeHtml(value: string): string { return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
function cleanText(value: string): string { return decodeHtml(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function safeName(value: string, fallback: string): string { return (value.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').replace(/^[ ._]+|[ ._]+$/g, '').slice(0, 120) || fallback).replace(/[ .]+$/g, ''); }
async function fileSize(path: string): Promise<number> { try { return (await stat(path)).size; } catch { return 0; } }
async function existsNonEmpty(path: string): Promise<boolean> { return (await fileSize(path)) > 0; }
async function hasSignature(path: string, signature: Buffer): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, 'r');
    const data = Buffer.alloc(signature.length);
    const { bytesRead } = await handle.read(data, 0, signature.length, 0);
    return bytesRead === signature.length && data.equals(signature);
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}
