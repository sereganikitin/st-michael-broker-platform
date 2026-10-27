import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  IsDefined,
} from "class-validator";

export const REVIEW_VALUES = ["PASS", "FAIL", "NOT_OBSERVABLE"] as const;
export class AgencyReviewCriteriaDto {
  @IsIn(REVIEW_VALUES) offerCurrent!: string;
  @IsIn(REVIEW_VALUES) needsClarified!: string;
  @IsIn(REVIEW_VALUES) agreementRecorded!: string;
  @IsIn(REVIEW_VALUES) nextStepCorrect!: string;
}

export class AgencyCallReviewDto {
  @IsUUID("4") submissionId!: string;
  @Type(() => Number) @IsInt() @Min(0) expectedVersion!: number;
  @IsDefined()
  @ValidateNested()
  @Type(() => AgencyReviewCriteriaDto)
  criteria!: AgencyReviewCriteriaDto;
  @IsString() @MinLength(1) @MaxLength(4000) comment!: string;
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  correctionReason?: string;
}
