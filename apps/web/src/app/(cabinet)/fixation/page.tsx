'use client';

import { useState } from 'react';
import { apiPost } from '@/lib/api';

export default function FixationPage() {
  const [formData, setFormData] = useState({
    phone: '',
    fullName: '',
    comment: '',
    agencyInn: '',
    project: 'ZORGE9',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<any>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);

    try {
      const data = await apiPost('/clients/fix', formData);
      setResult(data);
      if (data.status !== 'REJECTED') {
        setFormData({ phone: '', fullName: '', comment: '', agencyInn: '', project: 'ZORGE9' });
      }
    } catch (err: any) {
      setError(err.message || 'Ошибка при фиксации клиента');
    }

    setLoading(false);
  };

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Фиксация клиента</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="label">ФИО клиента</label>
              <input
                type="text"
                className="input"
                placeholder="Иванов Иван Иванович"
                value={formData.fullName}
                onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
                required
              />
            </div>

            <div>
              <label className="label">Телефон клиента</label>
              <input
                type="tel"
                className="input"
                placeholder="+79991234567"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                required
              />
            </div>

            <div>
              <label className="label">Проект</label>
              <select
                className="input"
                value={formData.project}
                onChange={(e) => setFormData({ ...formData, project: e.target.value })}
              >
                <option value="ZORGE9">Зорге 9</option>
                <option value="SILVER_BOR">Серебряный бор</option>
              </select>
            </div>

            <div>
              <label className="label">ИНН агентства</label>
              <input
                type="text"
                className="input"
                placeholder="7701234567"
                value={formData.agencyInn}
                onChange={(e) => setFormData({ ...formData, agencyInn: e.target.value.replace(/\D/g, '').slice(0, 10) })}
                maxLength={10}
                required
              />
            </div>

            <div>
              <label className="label">Комментарий</label>
              <textarea
                className="input"
                rows={3}
                placeholder="Дополнительная информация..."
                value={formData.comment}
                onChange={(e) => setFormData({ ...formData, comment: e.target.value })}
              />
            </div>

            <button
              type="submit"
              className="btn btn-primary w-full"
              disabled={loading || !formData.phone || !formData.fullName || formData.agencyInn.length !== 10}
            >
              {loading ? 'Фиксация...' : 'Зафиксировать клиента'}
            </button>
          </form>
        </div>

        <div>
          {error && (
            <div className="card mb-4">
              <div className="p-3 bg-error/20 text-error rounded-lg text-sm">{error}</div>
            </div>
          )}

          {result && (
            <div className={`card ${result.status === 'REJECTED' ? 'border-error' : 'border-success'}`}>
              <h3 className="font-semibold mb-2">
                {result.status === 'REJECTED' ? 'Отклонено' :
                 result.status === 'UNDER_REVIEW' ? 'На проверке' :
                 'Успешно'}
              </h3>
              <p className="text-sm text-text-muted">{result.message}</p>
              {result.client && (
                <div className="mt-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-text-muted">Клиент:</span>
                    <span>{result.client.fullName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Статус:</span>
                    <span className={result.status === 'CONDITIONALLY_UNIQUE' ? 'text-success' : 'text-warning'}>
                      {result.status === 'CONDITIONALLY_UNIQUE' ? 'Условно уникален' : result.status}
                    </span>
                  </div>
                  {result.client.uniquenessExpiresAt && (
                    <div className="flex justify-between">
                      <span className="text-text-muted">Действует до:</span>
                      <span>{new Date(result.client.uniquenessExpiresAt).toLocaleDateString('ru-RU')}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="card mt-4">
            <h3 className="font-semibold mb-3">Как работает фиксация</h3>
            <ul className="space-y-2 text-sm text-text-muted">
              <li>1. Новый клиент получает условную уникальность на 30 дней</li>
              <li>2. Если клиент уже в закрытой сделке — она будет переоткрыта</li>
              <li>3. Если клиент на квалификации у другого брокера — менеджер будет уведомлён</li>
              <li>4. Если у клиента активная сделка — фиксация будет отклонена</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
