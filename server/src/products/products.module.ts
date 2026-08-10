import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsRepository } from './products.repository';
import { ProductsService } from './products.service';
import { StorageService } from './storage.service';

@Module({
  controllers: [ProductsController],
  providers: [ProductsRepository, ProductsService, StorageService],
  exports: [ProductsRepository, ProductsService, StorageService],
})
export class ProductsModule {}
