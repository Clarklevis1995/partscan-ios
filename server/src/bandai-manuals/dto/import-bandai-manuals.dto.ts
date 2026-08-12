import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ImportBandaiManualsDto {
  @IsOptional()
  @IsString()
  query = '';

  /** @deprecated Use query. */
  @IsOptional()
  @IsString()
  freeword = '';

  @IsOptional()
  @IsIn(['new', 'old', 'brand'])
  sort: 'new' | 'old' | 'brand' = 'new';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  startPage = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  endPage = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 3;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60_000)
  delayMs = 1500;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(72)
  @Max(600)
  jpgDpi = 200;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(8)
  splitColumns = 0;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  overwrite = false;
}
