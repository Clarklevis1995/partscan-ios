import { createCanvas } from '@napi-rs/canvas';
import { readFile, writeFile } from 'node:fs/promises';

// Sharp exposes a CommonJS callable; a default import compiles incorrectly with this project setup.
const sharp = require('sharp') as any;

export interface RenderedPdf {
  sheetCount: number;
  pageCount: number;
  columns: number;
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

const loadPdfJs = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<PdfJs>;

export async function renderAndCutPdf(
  pdfPath: string,
  sheetsDir: string,
  pagesDir: string,
  dpi: number,
  splitColumns: number,
  log: (message: string) => void = () => undefined,
): Promise<RenderedPdf> {
  log(`PDF parse started path=${pdfPath} dpi=${dpi} splitColumns=${splitColumns || 'auto'}`);
  const pdfjs = await loadPdfJs('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await readFile(pdfPath));
  const loadingTask = pdfjs.getDocument({ data });
  const document = await loadingTask.promise;
  log(`PDF parsed sheets=${document.numPages} bytes=${data.byteLength}`);
  let logicalPage = 1;
  let columns = splitColumns;

  try {
    for (let sheet = 1; sheet <= document.numPages; sheet += 1) {
      const page = await document.getPage(sheet);
      try {
        const baseViewport = page.getViewport({ scale: 1 });
        if (!columns) {
          columns = inferSplitColumns(baseViewport.width, baseViewport.height);
          log(`Split columns inferred columns=${columns} width=${baseViewport.width.toFixed(2)} height=${baseViewport.height.toFixed(2)}`);
        }
        const viewport = page.getViewport({ scale: dpi / 72 });
        const width = Math.ceil(viewport.width);
        const height = Math.ceil(viewport.height);
        log(`Sheet render started sheet=${sheet}/${document.numPages} width=${width} height=${height}`);
        const canvas = createCanvas(width, height);
        const context = canvas.getContext('2d');
        await page.render({
          canvas: null,
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
          background: 'rgb(255,255,255)',
        }).promise;
        const sheetBuffer = canvas.toBuffer('image/jpeg', 92);
        const sheetPath = `${sheetsDir}/sheet-${String(sheet).padStart(3, '0')}.jpg`;
        await writeFile(sheetPath, sheetBuffer);
        log(`Sheet JPG written sheet=${sheet}/${document.numPages} bytes=${sheetBuffer.byteLength} path=${sheetPath}`);

        for (let column = 0; column < columns; column += 1) {
          const left = Math.round(column * width / columns);
          const right = Math.round((column + 1) * width / columns);
          const pagePath = `${pagesDir}/page-${String(logicalPage).padStart(3, '0')}.jpg`;
          await sharp(sheetBuffer)
            .extract({ left, top: 0, width: right - left, height })
            .jpeg({ quality: 92, progressive: true })
            .withMetadata({ density: dpi })
            .toFile(pagePath);
          log(`Logical page JPG written page=${logicalPage} sheet=${sheet} column=${column + 1}/${columns} path=${pagePath}`);
          logicalPage += 1;
        }
      } finally {
        page.cleanup();
      }
    }
    const result = {
      sheetCount: document.numPages,
      pageCount: document.numPages * columns,
      columns,
    };
    log(`PDF processing completed sheets=${result.sheetCount} pages=${result.pageCount} columns=${result.columns}`);
    return result;
  } finally {
    await loadingTask.destroy();
  }
}

export function inferSplitColumns(width: number, height: number): number {
  if (width <= 0 || height <= 0) throw new Error('Invalid PDF page dimensions');
  return Math.max(1, Math.min(8, Math.round((width / height) / 0.7)));
}
