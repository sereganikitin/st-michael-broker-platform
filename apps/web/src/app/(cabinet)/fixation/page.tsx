'use client';

import { useState } from 'react';

export default function FixationPage() {
  const [formData, setFormData] = useState({
    phone: '',
    fullName: '',
    comment: '',
    agencyInn: '',
  });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const response = await fetch('/api/clients/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          project: 'ZORGE9',
        }),
      });

      if (response.ok) {
        alert('Клиент зафиксирован успешно!');
        setFormData({ phone: '', fullName: '', comment: '', agencyInn: '' });
      }
    } catch (error) {
      console.error('Fixation error:', error);
    }

    setLoading(false);
  };

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Фиксация клиента</h1>

      <div className="card max-w-2xl">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="label">ФИО клиента</label>
            <input
              type="text"
              className="input"
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
              placeholder="+7 (999) 123-45-67"
              value={formData.phone}
              onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              required
            />
          </div>

          <div>
            <label className="label">ИНН агентства</label>
            <input
              type="text"
              className="input"
              placeholder="7701234567"
              value={formData.agencyInn}
              onChange={(e) => setFormData({ ...formData, agencyInn: e.target.value })}
              maxLength={10}
              required
            />
          </div>

          <div>
            <label className="label">Комментарий</label>
            <textarea
              className="input"
              rows={3}
              value={formData.comment}
              onChange={(e) => setFormData({ ...formData, comment: e.target.value })}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary w-full"
            disabled={loading}
          >
            {loading ? 'Фиксация...' : 'Зафиксировать клиента'}
          </button>
        </form>
      </div>
    </div>
  );
}