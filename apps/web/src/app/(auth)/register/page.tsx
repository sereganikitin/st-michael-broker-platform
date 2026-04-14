'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function RegisterPage() {
  const [phoneDigits, setPhoneDigits] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [agencyName, setAgencyName] = useState('');
  const [inn, setInn] = useState('');
  const [innType, setInnType] = useState<'PERSONAL' | 'AGENCY'>('AGENCY');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const router = useRouter();

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPhoneDigits(e.target.value.replace(/\D/g, '').slice(0, 10));
  };

  const handleRegister = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: '+7' + phoneDigits,
          fullName,
          email,
          password,
          inn,
          innType,
          agencyName: agencyName || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setSuccess(true);
        setTimeout(() => router.push('/login'), 2000);
      } else {
        setError(data.message || 'Ошибка регистрации');
      }
    } catch {
      setError('Ошибка соединения с сервером');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="card w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-6">Регистрация</h1>

        {error && (
          <div className="mb-4 p-3 bg-error/20 text-error rounded-lg text-sm">
            {error}
          </div>
        )}

        {success ? (
          <div className="p-4 bg-success/20 text-success rounded-lg text-center">
            Регистрация успешна! Перенаправляем на вход...
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="label">ФИО</label>
              <input
                type="text"
                className="input"
                placeholder="Иванов Иван Иванович"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>

            <div>
              <label className="label">Номер телефона</label>
              <div className="flex">
                <span className="inline-flex items-center px-3 bg-surface-secondary border border-r-0 border-border rounded-l text-text-muted text-sm">+7</span>
                <input
                  type="tel"
                  className="input rounded-l-none"
                  placeholder="9991234567"
                  value={phoneDigits}
                  onChange={handlePhoneChange}
                  maxLength={10}
                />
              </div>
            </div>

            <div>
              <label className="label">Email</label>
              <input
                type="email"
                className="input"
                placeholder="example@mail.ru"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div>
              <label className="label">Название агентства</label>
              <input
                type="text"
                className="input"
                placeholder="Агентство недвижимости"
                value={agencyName}
                onChange={(e) => setAgencyName(e.target.value)}
              />
            </div>

            <div>
              <label className="label">ИНН</label>
              <input
                type="text"
                inputMode="numeric"
                className="input"
                placeholder="10 или 12 цифр"
                value={inn}
                onChange={(e) => setInn(e.target.value.replace(/\D/g, '').slice(0, 12))}
                maxLength={12}
              />
            </div>

            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="innType" checked={innType === 'PERSONAL'} onChange={() => setInnType('PERSONAL')} />
                Личный ИНН
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="innType" checked={innType === 'AGENCY'} onChange={() => setInnType('AGENCY')} />
                ИНН агентства
              </label>
            </div>

            <div>
              <label className="label">Пароль</label>
              <input
                type="password"
                className="input"
                placeholder="Минимум 6 символов"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <button
              className="btn btn-primary w-full"
              onClick={handleRegister}
              disabled={
                loading ||
                phoneDigits.length !== 10 ||
                !fullName ||
                !email ||
                (inn.length !== 10 && inn.length !== 12) ||
                password.length < 6
              }
            >
              {loading ? 'Регистрация...' : 'Зарегистрироваться'}
            </button>
          </div>
        )}

        <div className="mt-6 text-center">
          <Link href="/login" className="text-accent hover:text-accent-hover">
            Уже есть аккаунт? Войти
          </Link>
        </div>
      </div>
    </div>
  );
}
