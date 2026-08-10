import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { StartAnalysisDto } from './dto/start-analysis.dto';
import { AnalysisService } from './analysis.service';

@Controller()
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  @Get('analysis/models') models() { return this.analysis.models(); }

  @Post('products/:productId/analysis')
  start(@Param('productId') productId: string, @Body() body: StartAnalysisDto) {
    return this.analysis.start(productId, body.model, body.useOcr, {
      reasoningEffort: body.reasoningEffort,
      vlmBatchSize: body.vlmBatchSize,
      multiScaleEnabled: body.multiScaleEnabled,
    });
  }

  @Get('analysis/:id') get(@Param('id') id: string) { return this.analysis.get(id); }
  @Get('products/:productId/parts-list') partsList(@Param('productId') productId: string) { return this.analysis.getPartsList(productId); }
}
