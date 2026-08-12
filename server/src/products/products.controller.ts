import { Body, Controller, Delete, Get, Param, Post, Res, StreamableFile, UploadedFile, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { createReadStream } from 'node:fs';
import type { Response } from 'express';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductsService } from './products.service';

const imageLimits = { fileSize: Number(process.env.MAX_IMAGE_SIZE_MB ?? 12) * 1024 * 1024 };

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('cover', { limits: imageLimits }))
  create(@Body() body: CreateProductDto, @UploadedFile() cover?: Express.Multer.File) {
    return this.products.create(body.name, cover);
  }

  @Get() list() { return this.products.list(); }
  @Get(':id') get(@Param('id') id: string) { return this.products.get(id); }
  @Get(':id/cover')
  cover(@Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    const path = this.products.getCoverPath(id);
    response.type(path);
    return new StreamableFile(createReadStream(path));
  }

  @Post(':id/manual-pages')
  @UseInterceptors(FilesInterceptor('pages', 80, { limits: imageLimits }))
  addPages(@Param('id') id: string, @UploadedFiles() files: Express.Multer.File[], @Body('captureHints') captureHints?: string) {
    return this.products.addPages(id, files ?? [], captureHints);
  }

  @Delete(':id/manual-cache')
  clearManualCache(@Param('id') id: string) { return this.products.clearManualCache(id); }
}
