import { IsDefined, IsString, MaxLength, MinLength } from "class-validator";

export class AdminChangePasswordDto {
  @IsDefined()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;

  @IsDefined()
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  newPassword!: string;
}
