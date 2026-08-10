import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { AnalysisController } from './analysis.controller';
import { AnalysisRepository } from './analysis.repository';
import { AnalysisService } from './analysis.service';
import { QwenProvider } from './qwen.provider';
import { QwenOcrProvider } from './qwen-ocr.provider';
import { OcrTestController } from './ocr-test.controller';
import { TencentOcrProvider } from './tencent-ocr.provider';
import { OpenAIProvider } from './openai.provider';

@Module({
  imports: [ProductsModule],
  controllers: [AnalysisController, OcrTestController],
  providers: [AnalysisRepository, AnalysisService, QwenOcrProvider, TencentOcrProvider, QwenProvider, OpenAIProvider],
})
export class AnalysisModule {}
