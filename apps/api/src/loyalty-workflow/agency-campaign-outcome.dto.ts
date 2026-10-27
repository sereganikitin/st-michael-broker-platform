import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export class AgencyCampaignOutcomeDto {
  @IsUUID("4") eventId!: string;
  @IsUUID("4") submissionId!: string;
  @Type(() => Number) @IsInt() @Min(0) expectedVersion!: number;
  @IsIn(["MEETING", "TOUR", "REACTIVATION"]) kind!: string;
  @IsIn(["PLANNED", "HELD", "CANCELLED", "REACTIVATED"]) status!: string;
  @IsISO8601({ strict: true }) occurredAt!: string;
  @IsString() @MinLength(1) @MaxLength(1000) basis!: string;
  @IsString() @MaxLength(2000) comment!: string;
  @IsOptional() @IsString() @MaxLength(1000) correctionReason?: string;
}
