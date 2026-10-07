'use client';

import { FormEvent, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { validateAdminPasswordInput } from '@/lib/admin-password';

export function AdminPasswordForm({ id, name, phone }: { id: string; name: string; phone: string }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const pending = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const validation = validateAdminPasswordInput(currentPassword, newPassword, confirmation);
    if (validation) {
      setMessage(validation);
      return;
    }
    if (!window.confirm(`Изменить пароль пользователя ${name} (${phone})? Его текущие сессии будут завершены.`)) return;
    pending.current = true;
    setSaving(true);
    setMessage('');
    try {
      await api(`/admin/brokers/${encodeURIComponent(id)}/password`, {
        method: 'POST', body: JSON.stringify({ currentPassword, newPassword }),
      });
      setMessage('Пароль изменён. Старые сессии и коды восстановления пользователя отозваны. Передайте новый пароль лично по защищённому каналу.');
    } catch {
      // Do not render arbitrary server/network errors alongside password data.
      setMessage('Смена пароля не подтверждена. Проверьте свой пароль и статус пользователя. При обрыве связи не повторяйте сразу: сначала уточните, применилось ли изменение.');
    } finally {
      setCurrentPassword(''); setNewPassword(''); setConfirmation('');
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <section className="mt-6 border-t border-border pt-5" aria-labelledby="admin-password-heading">
      <h2 id="admin-password-heading" className="text-lg font-semibold">Сменить пароль пользователя</h2>
      <p className="text-sm text-text-muted my-2">{name} · {phone}. Это обычный новый пароль, не временный. Текущие сессии пользователя будут завершены. Ваш пароль не изменится.</p>
      <form onSubmit={submit} className="space-y-3 max-w-lg">
        <fieldset disabled={saving} className="space-y-3">
          <div><label htmlFor="admin-current-password" className="label">Ваш текущий пароль администратора</label>
            <input id="admin-current-password" className="input" type="password" autoComplete="current-password" required maxLength={256} value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} /></div>
          <div><label htmlFor="target-new-password" className="label">Новый пароль пользователя</label>
            <input id="target-new-password" className="input" type="password" autoComplete="new-password" required maxLength={256} value={newPassword} onChange={e => setNewPassword(e.target.value)} />
            <p className="text-xs text-text-muted mt-1">От 12 до 128 символов. Не используйте телефон или имя.</p></div>
          <div><label htmlFor="target-confirm-password" className="label">Повторите новый пароль пользователя</label>
            <input id="target-confirm-password" className="input" type="password" autoComplete="new-password" required maxLength={256} value={confirmation} onChange={e => setConfirmation(e.target.value)} /></div>
          <button type="submit" className="btn btn-primary">{saving ? 'Изменение…' : 'Сменить пароль пользователя'}</button>
        </fieldset>
        {message && <p role="status" className="text-sm p-3 rounded-lg bg-surface-secondary">{message}</p>}
      </form>
    </section>
  );
}
