'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Info } from 'lucide-react';
import { parseApiError } from '@/lib/api';
import { SupportContacts } from '@/components/SupportContacts';

// 2026-06-15: подсветка обязательных полей при попытке submit (правки Ксении).
// До первого submit ошибки не показываем — не давим на пользователя.
// После submit поля с ошибкой подсвечиваем красной рамкой + текстом снизу.
type FieldErrors = Partial<Record<
  'fullName' | 'phone' | 'email' | 'inn' | 'password' | 'passwordConfirm' | 'offer' | 'privacy',
  string
>>;

export default function RegisterPage() {
  const [phoneDigits, setPhoneDigits] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [agencyName, setAgencyName] = useState('');
  const [inn, setInn] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [offerAccepted, setOfferAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const router = useRouter();

  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPhoneDigits(e.target.value.replace(/\D/g, '').slice(0, 10));
  };

  const validate = (): FieldErrors => {
    const errs: FieldErrors = {};
    if (!fullName.trim()) errs.fullName = 'Заполните ФИО';
    if (phoneDigits.length !== 10) errs.phone = 'Введите 10 цифр номера';
    if (!email) errs.email = 'Введите email';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.email = 'Неверный формат email';
    if (inn.length !== 10 && inn.length !== 12) errs.inn = 'ИНН должен быть 10 или 12 цифр';
    if (password.length < 8) errs.password = 'Минимум 8 символов';
    if (passwordConfirm !== password) errs.passwordConfirm = 'Пароли не совпадают';
    if (!offerAccepted) errs.offer = 'Необходимо принять Договор-оферту';
    if (!privacyAccepted) errs.privacy = 'Необходимо дать согласие на обработку ПД';
    return errs;
  };

  const handleRegister = async () => {
    setSubmitted(true);
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

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
          innType: 'AGENCY',
          agencyName: agencyName || undefined,
          offerAccepted,
          privacyAccepted,
        }),
      });
      if (res.ok) {
        setSuccess(true);
        setTimeout(() => router.push('/'), 2000);
      } else {
        // 2026-06-26: бэкенд шлёт { message, field, errors: [{field, message}, ...] }.
        // Раскидываем ВСЕ ошибки по полям сразу — пользователь видит каждое
        // невалидное поле подсвеченным с пояснением, не по одной.
        const raw = await res.json().catch(() => null);
        const valid: Array<keyof FieldErrors> = ['fullName','phone','email','inn','password','passwordConfirm','offer','privacy'];
        const list: Array<{ field?: string; message: string }> = Array.isArray(raw?.errors)
          ? raw.errors
          : (raw?.field || raw?.message)
            ? [{ field: raw?.field, message: raw?.message }]
            : [];

        const next: FieldErrors = {};
        let leftover = '';
        for (const item of list) {
          const f = item.field as keyof FieldErrors | undefined;
          const msg = item.message || 'Проверьте поле';
          if (f && (valid as string[]).includes(f)) {
            next[f] = msg;
          } else if (!leftover) {
            leftover = msg;
          }
        }

        if (Object.keys(next).length > 0) {
          setFieldErrors((prev) => ({ ...prev, ...next }));
          setError(leftover);
        } else {
          setError(leftover || 'Ошибка регистрации');
        }
      }
    } catch {
      setError('Ошибка соединения с сервером');
    }
    setLoading(false);
  };

  // Перевалидация на лету после первого submit — чтобы подсветка снималась
  // сразу как пользователь ввёл недостающее.
  const onChange = <T extends string>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    if (submitted) {
      setFieldErrors(validate());
    }
  };

  const fieldClass = (k: keyof FieldErrors) =>
    `input${fieldErrors[k] ? ' border-error focus:ring-error' : ''}`;

  const errorText = (k: keyof FieldErrors) =>
    fieldErrors[k] ? (
      <div className="text-xs text-error mt-1">{fieldErrors[k]}</div>
    ) : null;

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
              <label className="label">ФИО <span className="text-error">*</span></label>
              <input
                type="text"
                className={fieldClass('fullName')}
                placeholder="Иванов Иван Иванович"
                value={fullName}
                onChange={(e) => { setFullName(e.target.value); if (submitted) setFieldErrors(validate()); }}
              />
              {errorText('fullName')}
            </div>

            <div>
              <label className="label">Номер телефона <span className="text-error">*</span></label>
              <div className="flex">
                <span className="inline-flex items-center px-3 bg-surface-secondary border border-r-0 border-border rounded-l text-text-muted text-sm">+7</span>
                <input
                  type="tel"
                  className={fieldClass('phone') + ' rounded-l-none'}
                  placeholder="9991234567"
                  value={phoneDigits}
                  onChange={(e) => { handlePhoneChange(e); if (submitted) setFieldErrors(validate()); }}
                  maxLength={10}
                />
              </div>
              {errorText('phone')}
            </div>

            <div>
              <label className="label">Email <span className="text-error">*</span></label>
              {/* 2026-06-26: значок-уведомление с подсказкой о ФЗ №406-ФЗ.
                  Не блокирует submit — это инфо для пользователя, чтобы он
                  понимал почему регистрация через российский email
                  предпочтительнее. */}
              <div className="relative">
                <input
                  type="email"
                  className={fieldClass('email') + ' pr-10'}
                  placeholder="example@mail.ru"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); if (submitted) setFieldErrors(validate()); }}
                />
                <div className="absolute right-3 top-1/2 -translate-y-1/2 group">
                  <Info className="w-4 h-4 text-text-muted cursor-help" aria-label="Информация о требованиях к email" />
                  <div
                    role="tooltip"
                    className="invisible opacity-0 group-hover:visible group-hover:opacity-100 transition-opacity absolute right-0 top-full mt-1 z-20 w-72 p-3 text-xs text-text bg-surface border border-border rounded-lg shadow-lg leading-relaxed"
                  >
                    <p className="mb-2">
                      Согласно <strong>ФЗ №406-ФЗ</strong> авторизация на российских сайтах должна осуществляться через российский почтовый сервис.
                    </p>
                    <p>
                      Рекомендуем: <span className="text-accent">yandex.ru, mail.ru, rambler.ru, bk.ru</span> и подобные.
                    </p>
                  </div>
                </div>
              </div>
              {errorText('email')}
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
              <label className="label">ИНН агентства (юр. лица или ИП) <span className="text-error">*</span></label>
              <input
                type="text"
                inputMode="numeric"
                className={fieldClass('inn')}
                placeholder="10 цифр для юр. лица или 12 цифр для ИП"
                value={inn}
                onChange={(e) => { setInn(e.target.value.replace(/\D/g, '').slice(0, 12)); if (submitted) setFieldErrors(validate()); }}
                maxLength={12}
              />
              {errorText('inn')}
            </div>

            <div>
              <label className="label">Пароль <span className="text-error">*</span></label>
              <input
                type="password"
                className={fieldClass('password')}
                placeholder="Минимум 8 символов"
                value={password}
                onChange={(e) => { setPassword(e.target.value); if (submitted) setFieldErrors(validate()); }}
              />
              {errorText('password')}
            </div>

            <div>
              <label className="label">Повторите пароль <span className="text-error">*</span></label>
              <input
                type="password"
                className={fieldClass('passwordConfirm')}
                placeholder="Введите пароль ещё раз"
                value={passwordConfirm}
                onChange={(e) => { setPasswordConfirm(e.target.value); if (submitted) setFieldErrors(validate()); }}
              />
              {errorText('passwordConfirm')}
            </div>

            <div className="pt-2 border-t border-border space-y-3">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1 accent-accent"
                  checked={offerAccepted}
                  onChange={(e) => { setOfferAccepted(e.target.checked); if (submitted) setFieldErrors(validate()); }}
                />
                <span className="text-sm text-text leading-relaxed">
                  Я ознакомлен(а) и принимаю условия{' '}
                  <Link href="/offer" target="_blank" className="text-accent hover:underline">
                    Договора-оферты
                  </Link>{' '}
                  о сотрудничестве с партнёрами по продаже недвижимости{' '}
                  <span className="text-error">*</span>
                </span>
              </label>
              {fieldErrors.offer && <div className="text-xs text-error ml-6">{fieldErrors.offer}</div>}

              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1 accent-accent"
                  checked={privacyAccepted}
                  onChange={(e) => { setPrivacyAccepted(e.target.checked); if (submitted) setFieldErrors(validate()); }}
                />
                <span className="text-sm text-text leading-relaxed">
                  Я даю{' '}
                  <Link href="/privacy" target="_blank" className="text-accent hover:underline">
                    согласие на обработку персональных данных
                  </Link>{' '}
                  в соответствии с 152-ФЗ{' '}
                  <span className="text-error">*</span>
                </span>
              </label>
              {fieldErrors.privacy && <div className="text-xs text-error ml-6">{fieldErrors.privacy}</div>}
            </div>

            <button
              className="btn btn-primary w-full"
              onClick={handleRegister}
              disabled={loading}
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

        <SupportContacts title="Возникли вопросы при регистрации?" />
      </div>
    </div>
  );
}
