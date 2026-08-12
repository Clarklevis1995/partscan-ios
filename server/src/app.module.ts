import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { HealthController } from './health.controller';
import { HttpLoggingInterceptor } from './http-logging.interceptor';
import { ProductsModule } from './products/products.module';
import { AnalysisModule } from './analysis/analysis.module';
import { BandaiManualsModule } from './bandai-manuals/bandai-manuals.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ProductsModule, AnalysisModule, BandaiManualsModule],
  controllers: [HealthController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor }],
})
export class AppModule {}
