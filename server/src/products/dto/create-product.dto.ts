import { IsString, Length } from 'class-validator';

export class CreateProductDto {
  @IsString()
  @Length(1, 120)
  name: string;
}
