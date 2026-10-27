import {
  IsInt,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { Type } from "class-transformer";
export class AgencyDelayReasonDto {
  @IsUUID("4") submissionId!: string;
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @IsString() @MinLength(1) @MaxLength(1000) reason!: string;
}
