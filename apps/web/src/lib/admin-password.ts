export function validateAdminPasswordInput(current: string, next: string, confirmation: string): string | null {
  if (!current || [...current].length > 128) return 'Введите текущий пароль администратора.';
  if ([...next].length < 12 || [...next].length > 128) return 'Новый пароль должен содержать от 12 до 128 символов.';
  if (next !== confirmation) return 'Подтверждение нового пароля не совпадает.';
  return null;
}
