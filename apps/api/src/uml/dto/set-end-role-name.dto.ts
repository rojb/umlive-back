import { IsString, MaxLength, ValidateIf } from 'class-validator';
import type { SetEndRoleNameRequest } from '@umlive/contracts';
import { NoNulBytes } from './no-nul-bytes.decorator';

/** `@MaxLength(120)`/`@NoNulBytes()` (verify-report 2026-09-18, RW-4). */
export class SetEndRoleNameDto implements SetEndRoleNameRequest {
  @ValidateIf((o: SetEndRoleNameDto) => o.roleName !== null)
  @IsString()
  @MaxLength(120)
  @NoNulBytes()
  roleName!: string | null;
}
