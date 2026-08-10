import { BadRequestException, Controller, NotFoundException, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { QwenOcrProvider } from './qwen-ocr.provider';
import { TencentOcrProvider } from './tencent-ocr.provider';

const imageLimits = { fileSize: Number(process.env.MAX_IMAGE_SIZE_MB ?? 12) * 1024 * 1024 };

@Controller('testing/ocr')
export class OcrTestController {
  constructor(
    private readonly ocr: QwenOcrProvider,
    private readonly tencentOcr: TencentOcrProvider,
    private readonly config: ConfigService,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('image', { limits: imageLimits }))
  async recognize(
    @UploadedFile() image?: Express.Multer.File,
    @Query('provider') provider = 'qwen',
  ) {
    if (this.config.get('NODE_ENV', 'development') === 'production') throw new NotFoundException();
    if (!['qwen', 'tencent'].includes(provider)) {
      throw new BadRequestException('provider must be "qwen" or "tencent"');
    }
    if (!image?.buffer?.length) throw new BadRequestException('multipart field "image" is required');
    if (!image.mimetype.startsWith('image/')) throw new BadRequestException('Only image files are supported');

    const result = provider === 'tencent'
      ? await this.tencentOcr.recognizeImage(image.buffer)
      : await this.ocr.recognizeImage(image.buffer, image.mimetype);
    return {
      provider,
      filename: image.originalname,
      mimeType: image.mimetype,
      bytes: image.size,
      ...result,
    };
  }
}
