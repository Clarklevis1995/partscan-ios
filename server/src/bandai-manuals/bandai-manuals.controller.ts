import { Body, Controller, Post } from '@nestjs/common';
import { BandaiManualsService } from './bandai-manuals.service';
import { ImportBandaiManualsDto } from './dto/import-bandai-manuals.dto';

@Controller('bandai-manuals')
export class BandaiManualsController {
  constructor(private readonly manuals: BandaiManualsService) {}

  @Post('import')
  import(@Body() body: ImportBandaiManualsDto) {
    return this.manuals.import(body);
  }
}
