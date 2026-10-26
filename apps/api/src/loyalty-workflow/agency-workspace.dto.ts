import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  Matches,
  ValidateNested,
} from "class-validator";

export class AgencyWorkspaceQuery {
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
  @IsOptional() @IsUUID("4") assigneeId?: string;
  @IsOptional() @IsUUID("4") campaignId?: string;
}

export class AgencyPilotDto {
  @IsUUID("4") submissionId!: string;
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsUUID("4", { each: true })
  agencyIds!: string[];
  @IsUUID("4") assigneeId!: string;
  @IsString() @MinLength(1) @MaxLength(100) sourceHash!: string;
}

export class AgencyScriptDto {
  @Type(() => Number) @IsInt() @Min(0) expectedVersion!: number;
  @IsString() @MinLength(1) @MaxLength(4000) text!: string;
  @IsString() @MinLength(1) @MaxLength(160) owner!: string;
  @IsISO8601({ strict: true }) validUntil!: string;
}

export class AgencyCallControlDto {
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @IsBoolean() doNotCall!: boolean;
  @IsString() @MinLength(1) @MaxLength(1000) reason!: string;
}

export class AgencyContactDto {
  @IsUUID("4") id!: string;
  @IsString() @MinLength(1) @MaxLength(160) name!: string;
  @IsString() @MaxLength(160) role!: string;
  @IsString() @Matches(/^$|^\+?[\d ()-]{5,30}$/) phone!: string;
  @IsString() @Matches(/^$|^\+?[\d ()-]{5,30}$/) alternatePhone!: string;
  @IsString() @MinLength(1) @MaxLength(240) source!: string;
  @IsISO8601({ strict: true }) verifiedAt!: string;
  @IsBoolean() archived!: boolean;
}

export class AgencyContactsDto {
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AgencyContactDto)
  contacts!: AgencyContactDto[];
}

export class AgencyReassignDto {
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @IsUUID("4") assigneeId!: string;
}

export class AgencyClaimDto {
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
  @IsUUID("4") workSessionId!: string;
}
