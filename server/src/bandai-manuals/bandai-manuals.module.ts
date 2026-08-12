import { Module } from '@nestjs/common';
import { BandaiManualsController } from './bandai-manuals.controller';
import { BandaiManualsService } from './bandai-manuals.service';

@Module({
  controllers: [BandaiManualsController],
  providers: [BandaiManualsService],
})
export class BandaiManualsModule {}
