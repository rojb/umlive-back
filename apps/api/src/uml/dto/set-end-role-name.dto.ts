import { IsString, ValidateIf } from 'class-validator';
import type { SetEndRoleNameRequest } from '@umlive/contracts';

export class SetEndRoleNameDto implements SetEndRoleNameRequest {
  @ValidateIf((o: SetEndRoleNameDto) => o.roleName !== null)
  @IsString()
  roleName!: string | null;
}
