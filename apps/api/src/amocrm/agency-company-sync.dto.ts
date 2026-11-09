import { IsIn, IsUUID } from 'class-validator';

export class AgencyCompanySyncDto {
  @IsIn(['apply', 'dry-run'])
  mode!: 'apply' | 'dry-run';

  @IsUUID()
  agencyId!: string;
}
