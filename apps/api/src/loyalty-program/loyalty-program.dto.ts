import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class LoyaltyProgramDecideDto {
  @IsString()
  @MaxLength(120)
  partnerKey!: string;

  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @IsOptional()
  @IsUUID()
  personId?: string;

  @IsOptional()
  @IsIn(["MANUAL", "SKIPPED"])
  status?: "MANUAL" | "SKIPPED";
}
