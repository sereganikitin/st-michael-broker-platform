'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';

export default function LoginPage() {
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { login } = useAuth();

  const handleSendOtp = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (res.ok) {
        setStep('otp');
      } else {
        setError(data.message || 'Ошибка отправки SMS');
      }
    } catch {
      setError('Ошибка соединения с сервером');
    }
    setLoading(false);
  };

  const handleVerifyOtp = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, otp }),
      });
      const data = await res.json();
      if (res.ok) {
        login(data.accessToken, data.refreshToken);
      } else {
        setError(data.message || 'Неверный код');
      }
    } catch {
      setError('Ошибка соединения с сервером');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="card w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-6">Вход в кабинет</h1>

        {error && (
          <div className="mb-4 p-3 bg-error/20 text-error rounded-lg text-sm">
            {error}
          </div>
        )}

        {step === 'phone' ? (
          <div>
            <label className="label">Номер телефона</label>
            <input
              type="tel"
              className="input"
              placeholder="+79991234567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <button
              className="btn btn-primary w-full mt-4"
              onClick={handleSendOtp}
              disabled={loading || !phone}
            >
              {loading ? 'Отправка...' : 'Получить SMS'}
            </button>
          </div>
        ) : (
          <div>
            <p className="text-text-muted text-sm mb-4">
              Код отправлен на {phone}
            </p>
            <label className="label">Код из SMS</label>
            <input
              type="text"
              className="input text-center text-2xl tracking-widest"
              placeholder="0000"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 4))}
              maxLength={4}
              autoFocus
            />
            <button
              className="btn btn-primary w-full mt-4"
              onClick={handleVerifyOtp}
              disabled={loading || otp.length !== 4}
            >
              {loading ? 'Проверка...' : 'Войти'}
            </button>
            <button
              className="btn btn-secondary w-full mt-2"
              onClick={() => { setStep('phone'); setOtp(''); setError(''); }}
            >
              Изменить номер
            </button>
          </div>
        )}

        <div className="mt-6 text-center">
          <Link href="/register" className="text-accent hover:text-accent-hover">
            Регистрация
          </Link>
        </div>
      </div>
    </div>
  );
}
