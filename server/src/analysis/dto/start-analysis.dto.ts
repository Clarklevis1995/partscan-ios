import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AnalysisModel, ReasoningEffort } from '../../domain';

export class StartAnalysisDto {
  @IsOptional()
  @IsIn(['qwen3.7-flash', 'qwen3.7-plus', 'qwen3.7-max', 'qwen3.8-max', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
  model: AnalysisModel = 'qwen3.7-flash';

  @IsOptional()
  @IsBoolean()
  useOcr = true;

  @IsOptional()
  @IsIn(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  reasoningEffort: ReasoningEffort = 'medium';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  vlmBatchSize = 3;

  @IsOptional()
  @IsBoolean()
  multiScaleEnabled = true;
}
