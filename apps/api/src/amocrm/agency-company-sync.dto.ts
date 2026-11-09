import { IsIn, IsUUID } from 'class-validator';

export class AgencyCompanySyncAllDto {
  @IsIn(['apply', 'dry-run'])
  mode!: 'apply' | 'dry-run';
}

export class AgencyCompanySyncDto extends AgencyCompanySyncAllDto {
  @IsUUID()
  agencyId!: string;
}
