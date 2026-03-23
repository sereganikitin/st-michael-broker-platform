'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function LoginPage() {
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSendOtp = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      if (response.ok) {
        setStep('otp');
      }
    } catch (error) {
      console.error('Login error:', error);
    }
    setLoading(false);
  };

  const handleVerifyOtp = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, otp }),
      });
      if (response.ok) {
        router.push('/dashboard');
      }
    } catch (error) {
      console.error('OTP verification error:', error);
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="card w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-6">Вход в кабинет</h1>

        {step === 'phone' ? (
          <div>
            <label className="label">Номер телефона</label>
            <input
              type="tel"
              className="input"
              placeholder="+7 (999) 123-45-67"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <button
              className="btn btn-primary w-full mt-4"
              onClick={handleSendOtp}
              disabled={loading}
            >
              {loading ? 'Отправка...' : 'Получить SMS'}
            </button>
          </div>
        ) : (
          <div>
            <label className="label">Код из SMS</label>
            <input
              type="text"
              className="input"
              placeholder="1234"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              maxLength={4}
            />
            <button
              className="btn btn-primary w-full mt-4"
              onClick={handleVerifyOtp}
              disabled={loading}
            >
              {loading ? 'Проверка...' : 'Войти'}
            </button>
            <button
              className="btn btn-secondary w-full mt-2"
              onClick={() => setStep('phone')}
            >
              Назад
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