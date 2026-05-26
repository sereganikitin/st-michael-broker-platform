'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Plus, Trash2, CheckCircle2, X } from 'lucide-react';

interface Participant {
  firstName: string;
  lastName: string;
  phone: string;
}

// Форматирование 10 цифр в +7 (XXX) XXX-XX-XX (правка 2026-05-14).
function formatPhoneFromDigits(digits10: string): string {
  if (!digits10) return '';
  const d = digits10.padEnd(10, '_').slice(0, 10);
  let out = '+7';
  if (digits10.length > 0) out += ' (' + d.slice(0, 3).replace(/_/g, '');
  if (digits10.length >= 3) out = '+7 (' + d.slice(0, 3) + ')';
  if (digits10.length > 3) out += ' ' + d.slice(3, 6).replace(/_/g, '');
  if (digits10.length >= 6) out = '+7 (' + d.slice(0, 3) + ') ' + d.slice(3, 6);
  if (digits10.length > 6) out += '-' + d.slice(6, 8).replace(/_/g, '');
  if (digits10.length >= 8) out = '+7 (' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6, 8);
  if (digits10.length > 8) out += '-' + d.slice(8, 10).replace(/_/g, '');
  return out;
}

// Форматирование числа с разделителями тысяч пробелами (для бюджета).
function formatMoney(raw: string): string {
  const d = raw.replace(/\D/g, '');
  if (!d) return '';
  return d.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export default function FixationPage() {
  const router = useRouter();
  const { broker } = useAuth();

  const [isForeign, setIsForeign] = useState(false); // правка 2026-05-14: иностранные номера
  const [phoneDigits, setPhoneDigits] = useState(''); // только цифры для RU +7
  const [foreignPhone, setForeignPhone] = useState(''); // raw text для иностранных
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState(''); // правка 2026-05-15: необязательное
  const [lastName, setLastName] = useState('');
  const [project, setProject] = useState('ZORGE9');
  const [propertyType, setPropertyType] = useState<'Квартира' | 'Апартаменты' | 'Коммерческая'>('Квартира');
  const [roomsCount, setRoomsCount] = useState<string>(''); // студия/1/2/3/4+
  const [sqm, setSqm] = useState('');
  const [amount, setAmount] = useState(''); // raw digits
  const [participants, setParticipants] = useState<Participant[]>([]);
  // Правка 2026-05-22: новые поля по КБ3 (amo интеграция)
  const [clientRegion, setClientRegion] = useState('');
  const [presentationSent, setPresentationSent] = useState(false);
  const [purchaseTiming, setPurchaseTiming] = useState('');
  const [readinessLevel, setReadinessLevel] = useState<'Холодный' | 'Тёплый' | 'Горячий' | ''>('Тёплый');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);
  // КБ7 (2026-05-26): пользователь нажал «Отправить» хотя бы раз —
  // с этого момента подсвечиваем красным невалидные поля и пишем
  // под каждым «Заполните это поле». До первой попытки не дёргаем.
  const [attempted, setAttempted] = useState(false);
  // 2026-05-25: если amo упал — показываем брокеру предупреждение и
  // список менеджеров с телефонами, чтобы он мог позвонить напрямую.
  const [amoWarn, setAmoWarn] = useState<{
    message: string;
    managers: { fullName: string; phone: string; telegram: string | null }[];
  } | null>(null);

  const brokerAgency = broker?.agencies?.[0];

  const addParticipant = () => {
    setParticipants([...participants, { firstName: '', lastName: '', phone: '' }]);
  };

  const removeParticipant = (i: number) => {
    setParticipants(participants.filter((_, idx) => idx !== i));
  };

  const updateParticipant = (i: number, field: keyof Participant, value: string) => {
    setParticipants(participants.map((p, idx) => idx === i ? { ...p, [field]: value } : p));
  };

  const updateParticipantPhone = (i: number, raw: string) => {
    // Извлекаем цифры. Поддерживаем paste полного номера:
    // «+79991234567», «89991234567», «79991234567» → «9991234567».
    let d = raw.replace(/\D/g, '');
    if (d.length === 11 && (d[0] === '7' || d[0] === '8')) d = d.slice(1);
    updateParticipant(i, 'phone', d.slice(0, 10));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    // КБ7: валидируем перед отправкой. Если что-то не так — показываем
    // пользователю красные поля и НЕ дёргаем сервер.
    const foreignD = foreignPhone.replace(/\D/g, '').length;
    const phoneOk = isForeign ? foreignD >= 7 : phoneDigits.length === 10;
    if (!phoneOk || !firstName.trim() || !sqm || !amount || !brokerAgency?.inn) {
      setError('Заполните все обязательные поля (отмечены красным)');
      // Прокрутим к первому невалидному.
      setTimeout(() => {
        const el = document.querySelector('.field-invalid') as HTMLElement | null;
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 50);
      return;
    }
    setLoading(true);
    setError('');

    const fullName = (lastName ? `${lastName} ${firstName}` : firstName).trim();
    // Нормализация телефона: для RU '+7' + 10 цифр, для иностранного — '+<digits>'.
    let phone: string;
    if (isForeign) {
      const digits = foreignPhone.replace(/\D/g, '');
      phone = digits ? '+' + digits : '';
    } else {
      phone = '+7' + phoneDigits;
    }

    const payload = {
      phone,
      fullName,
      email: email || undefined,
      project,
      agencyInn: brokerAgency?.inn || '',
      propertyType,
      roomsCount: roomsCount || undefined,
      amount: amount ? Number(amount) : undefined,
      sqm: sqm ? Number(sqm) : undefined,
      clientRegion: clientRegion || undefined,
      presentationSent,
      purchaseTiming: purchaseTiming || undefined,
      readinessLevel: readinessLevel || undefined,
      participants: participants
        .filter((p) => p.firstName || p.lastName || p.phone)
        .map((p) => ({
          firstName: p.firstName,
          lastName: p.lastName,
          phone: p.phone ? '+7' + p.phone : '',
        })),
    };

    try {
      const result: any = await apiPost('/clients/fix', payload);
      // 2026-05-26: если бэк говорит «уже есть твой клиент» — спрашиваем
      // подтверждение и при OK повторяем с confirmDuplicate=true.
      if (result?.status === 'REQUIRES_CONFIRMATION') {
        const fmt = (s: any) => s ? new Date(s).toLocaleDateString('ru-RU') : '—';
        const ec = result.existingClient || {};
        const ok = window.confirm(
          `${result.message}\n\n` +
          `Существующая фиксация:\n` +
          `• ${ec.fullName} (${ec.phone})\n` +
          `• Статус: ${ec.uniquenessStatus}\n` +
          `• Создана: ${fmt(ec.createdAt)}\n` +
          `• Активна до: ${fmt(ec.uniquenessExpiresAt)}\n` +
          `• Сделок: ${ec.dealsCount}\n\n` +
          `Создать новую фиксацию всё равно?`
        );
        if (!ok) { setLoading(false); return; }
        const result2: any = await apiPost('/clients/fix', { ...payload, confirmDuplicate: true });
        if (result2?.amoSyncStatus === 'FAILED' && Array.isArray(result2?.managerContacts)) {
          setAmoWarn({
            message: result2.message || 'Заявка сохранена в кабинете, но не передана в amoCRM.',
            managers: result2.managerContacts,
          });
        }
        setShowSuccess(true);
      } else {
        if (result?.amoSyncStatus === 'FAILED' && Array.isArray(result?.managerContacts)) {
          setAmoWarn({
            message: result.message || 'Заявка сохранена в кабинете, но не передана в amoCRM.',
            managers: result.managerContacts,
          });
        }
        setShowSuccess(true);
      }
    } catch (err: any) {
      setError(err.message || 'Ошибка при отправке заявки');
    }

    setLoading(false);
  };

  const resetForm = () => {
    setPhoneDigits('');
    setForeignPhone('');
    setIsForeign(false);
    setFirstName('');
    setEmail('');
    setLastName('');
    setProject('ZORGE9');
    setPropertyType('Квартира');
    setRoomsCount('');
    setSqm('');
    setAmount('');
    setParticipants([]);
    setClientRegion('');
    setPresentationSent(false);
    setPurchaseTiming('');
    setReadinessLevel('Тёплый');
    setShowSuccess(false);
    setAmoWarn(null);
  };

  const brokerPhoneDisplay = broker?.phone || '—';
  const brokerNameDisplay = broker?.fullName || '—';
  // Минимум для submit: валидный телефон + имя + метраж + сумма + ИНН агентства.
  const foreignDigitsCount = foreignPhone.replace(/\D/g, '').length;
  const phoneValid = isForeign ? foreignDigitsCount >= 7 : phoneDigits.length === 10;
  const canSubmit = phoneValid && !!firstName && !!sqm && !!amount && !!brokerAgency?.inn;

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl md:text-3xl font-bold mb-6">Фиксация клиента</h1>

      <div className="card">
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="label mb-0">Телефон клиента *</label>
              <label className="text-xs text-text-muted flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isForeign}
                  onChange={(e) => { setIsForeign(e.target.checked); setPhoneDigits(''); setForeignPhone(''); }}
                />
                Иностранный номер
              </label>
            </div>
            {!isForeign ? (
              <>
                <div className="flex">
                  <span className={`inline-flex items-center px-3 bg-surface-secondary border border-r-0 rounded-l text-text-muted text-sm ${attempted && phoneDigits.length !== 10 ? 'border-error field-invalid' : 'border-border'}`}>+7</span>
                  <input
                    type="tel"
                    className={`input rounded-l-none ${attempted && phoneDigits.length !== 10 ? 'border-error field-invalid' : ''}`}
                    placeholder="(999) 123-45-67"
                    // value — отформатированный «(999) 123-45-67» от текущих phoneDigits.
                    // При onChange — извлекаем только цифры (не больше 10).
                    value={(() => {
                      const d = phoneDigits;
                      if (!d) return '';
                      let out = '(' + d.slice(0, 3);
                      if (d.length > 3) out += ') ' + d.slice(3, 6);
                      if (d.length > 6) out += '-' + d.slice(6, 8);
                      if (d.length > 8) out += '-' + d.slice(8, 10);
                      return out;
                    })()}
                    onChange={(e) => {
                      // Извлекаем цифры. Если 11 цифр и начинаются на 7 или 8
                      // — это вставлен полный номер (+79991234567 / 89991234567),
                      // отбрасываем код страны/префикс. Иначе берём первые 10.
                      let d = e.target.value.replace(/\D/g, '');
                      if (d.length === 11 && (d[0] === '7' || d[0] === '8')) {
                        d = d.slice(1);
                      }
                      setPhoneDigits(d.slice(0, 10));
                    }}
                    inputMode="numeric"
                    required
                  />
                </div>
                {phoneDigits.length === 10 && (
                  <div className="text-xs text-text-muted mt-1">{formatPhoneFromDigits(phoneDigits)}</div>
                )}
                {attempted && phoneDigits.length !== 10 && (
                  <div className="text-xs text-error mt-1">Заполните это поле — телефон 10 цифр</div>
                )}
              </>
            ) : (
              <>
                <input
                  type="tel"
                  className={`input ${attempted && foreignDigitsCount < 7 ? 'border-error field-invalid' : ''}`}
                  placeholder="+998 90 123 45 67"
                  value={foreignPhone}
                  onChange={(e) => setForeignPhone(e.target.value)}
                  required
                />
                <div className="text-xs text-text-muted mt-1">Иностранный — введи полный номер с кодом страны (любой формат)</div>
                {attempted && foreignDigitsCount < 7 && (
                  <div className="text-xs text-error mt-1">Заполните это поле — минимум 7 цифр</div>
                )}
              </>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Имя *</label>
              <input
                type="text"
                className={`input ${attempted && !firstName.trim() ? 'border-error field-invalid' : ''}`}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
              />
              {attempted && !firstName.trim() && (
                <div className="text-xs text-error mt-1">Заполните это поле</div>
              )}
            </div>
            <div>
              <label className="label">Фамилия</label>
              <input
                type="text"
                className="input"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="label">Email</label>
            <input
              type="email"
              className="input"
              placeholder="client@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Проект *</label>
              <select
                className="input"
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                <option value="ZORGE9">Зорге 9</option>
                <option value="SILVER_BOR">Серебряный бор</option>
              </select>
            </div>
            <div>
              <label className="label">Тип *</label>
              <select
                className="input"
                value={propertyType}
                onChange={(e) => setPropertyType(e.target.value as any)}
              >
                <option value="Квартира">Квартира</option>
                <option value="Апартаменты">Апартаменты</option>
                <option value="Коммерческая">Коммерческая</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Кол-во комнат</label>
              <select
                className="input"
                value={roomsCount}
                onChange={(e) => setRoomsCount(e.target.value)}
              >
                <option value="">— не указано —</option>
                <option value="Студия">Студия</option>
                <option value="1к">1 комната</option>
                <option value="2к">2 комнаты</option>
                <option value="3к">3 комнаты</option>
                <option value="4к+">4+ комнаты</option>
              </select>
            </div>
            <div>
              <label className="label">Метраж, м² *</label>
              <input
                type="number"
                min="0"
                step="0.01"
                className={`input ${attempted && !sqm ? 'border-error field-invalid' : ''}`}
                placeholder="45.5"
                value={sqm}
                onChange={(e) => setSqm(e.target.value)}
                required
              />
              {attempted && !sqm && (
                <div className="text-xs text-error mt-1">Заполните это поле</div>
              )}
            </div>
          </div>

          <div>
            <label className="label">Бюджет покупки, ₽ *</label>
            <input
              type="text"
              inputMode="numeric"
              className={`input ${attempted && !amount ? 'border-error field-invalid' : ''}`}
              placeholder="25 000 000"
              value={formatMoney(amount)}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
              required
            />
            {amount && (
              <div className="text-xs text-text-muted mt-1">
                {Number(amount).toLocaleString('ru-RU')} ₽
              </div>
            )}
            {attempted && !amount && (
              <div className="text-xs text-error mt-1">Заполните это поле</div>
            )}
          </div>

          {/* Дополнительные поля для amoCRM-лида (правка 2026-05-22, КБ3) */}
          <div className="border-t border-border pt-4 mt-2">
            <div className="text-xs font-semibold text-text-muted uppercase mb-3">Доп. информация о клиенте (заполнится в amoCRM)</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="label">Регион клиента</label>
                <input
                  type="text"
                  className="input"
                  placeholder="Москва / СПб / другой"
                  value={clientRegion}
                  onChange={(e) => setClientRegion(e.target.value)}
                />
              </div>
              <div>
                <label className="label">Планирует покупку</label>
                <select className="input" value={purchaseTiming} onChange={(e) => setPurchaseTiming(e.target.value)}>
                  <option value="">— не указано —</option>
                  <option value="до 1 месяца">до 1 месяца</option>
                  <option value="от 1 до 3 месяцев">от 1 до 3 месяцев</option>
                  <option value="от 3 до 6 месяцев">от 3 до 6 месяцев</option>
                  <option value="от 6 до 12 месяцев">от 6 до 12 месяцев</option>
                  <option value="более 12 месяцев">более 12 месяцев</option>
                </select>
              </div>
              <div>
                <label className="label">Готовность к сделке</label>
                <select className="input" value={readinessLevel} onChange={(e) => setReadinessLevel(e.target.value as any)}>
                  <option value="">— не указано —</option>
                  <option value="Холодный">Холодный</option>
                  <option value="Тёплый">Тёплый</option>
                  <option value="Горячий">Горячий</option>
                </select>
              </div>
              {/* Чекбокс «Презентация отправлена» убран 2026-05-22 по запросу:
                  это решает менеджер уже после звонка клиенту, не брокер при фиксации. */}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-border">
            <div>
              <label className="label">ФИО брокера</label>
              <input type="text" className="input bg-surface-secondary" value={brokerNameDisplay} readOnly />
            </div>
            <div>
              <label className="label">Телефон брокера</label>
              <input type="text" className="input bg-surface-secondary" value={brokerPhoneDisplay} readOnly />
            </div>
          </div>

          {participants.length > 0 && (
            <div className="space-y-3 pt-4 border-t border-border">
              <div className="text-sm font-medium">Дополнительные участники</div>
              {participants.map((p, i) => (
                <div key={i} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end">
                  <div>
                    <label className="label text-xs">Имя</label>
                    <input
                      type="text"
                      className="input"
                      value={p.firstName}
                      onChange={(e) => updateParticipant(i, 'firstName', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="label text-xs">Фамилия</label>
                    <input
                      type="text"
                      className="input"
                      value={p.lastName}
                      onChange={(e) => updateParticipant(i, 'lastName', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="label text-xs">Телефон</label>
                    <input
                      type="tel"
                      className="input"
                      placeholder="+7 (999) 123-45-67"
                      value={p.phone ? formatPhoneFromDigits(p.phone) : ''}
                      onChange={(e) => updateParticipantPhone(i, e.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary text-error"
                    onClick={() => removeParticipant(i)}
                    aria-label="Удалить"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            className="btn btn-secondary flex items-center gap-2"
            onClick={addParticipant}
          >
            <Plus className="w-4 h-4" /> Добавить участника (супруг и т.д.)
          </button>

          {error && (
            <div className="p-3 bg-error/20 text-error rounded-lg text-sm">{error}</div>
          )}

          <button
            type="submit"
            className="btn btn-primary w-full"
            disabled={loading}
          >
            {loading ? 'Отправка...' : 'Отправить заявку'}
          </button>

          {attempted && !brokerAgency?.inn && (
            <div className="text-xs text-error">
              У вас не привязано агентство с ИНН. Заполните данные в Профиле перед фиксацией.
            </div>
          )}
        </form>
      </div>

      {showSuccess && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setShowSuccess(false)}>
          <div
            className="bg-surface rounded-xl max-w-md w-full p-6 relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="absolute top-4 right-4 text-text-muted hover:text-text"
              onClick={() => setShowSuccess(false)}
            >
              <X className="w-5 h-5" />
            </button>
            <div className="text-center py-4">
              {amoWarn ? (
                <>
                  <div className="mx-auto w-16 h-16 bg-warning/20 rounded-full flex items-center justify-center mb-4">
                    <CheckCircle2 className="w-10 h-10 text-warning" />
                  </div>
                  <h2 className="text-xl font-bold mb-2">Заявка сохранена</h2>
                  <p className="text-text-muted mb-4 text-sm text-left">{amoWarn.message}</p>
                  {amoWarn.managers.length > 0 && (
                    <div className="text-left bg-warning/10 border border-warning/30 rounded p-3 mb-4 text-sm">
                      <div className="font-semibold mb-2">Менеджеры по брокерам:</div>
                      <ul className="space-y-1">
                        {amoWarn.managers.map((m, i) => (
                          <li key={i} className="flex flex-wrap items-center gap-x-2">
                            <span>{m.fullName}</span>
                            {m.phone && (
                              <a href={`tel:${m.phone}`} className="text-accent underline">{m.phone}</a>
                            )}
                            {m.telegram && (
                              <a href={`https://t.me/${m.telegram.replace(/^@/, '')}`} target="_blank" rel="noreferrer" className="text-info underline">tg: @{m.telegram.replace(/^@/, '')}</a>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="mx-auto w-16 h-16 bg-success/20 rounded-full flex items-center justify-center mb-4">
                    <CheckCircle2 className="w-10 h-10 text-success" />
                  </div>
                  <h2 className="text-2xl font-bold mb-2">Запрос отправлен</h2>
                  <p className="text-text-muted mb-6 text-sm">Заявка на фиксацию клиента успешно создана.</p>
                </>
              )}
              <div className="flex flex-col gap-2">
                <button
                  className="btn btn-primary w-full"
                  onClick={() => router.push('/clients')}
                >
                  Перейти к заявкам
                </button>
                <button
                  className="btn btn-secondary w-full"
                  onClick={resetForm}
                >
                  Создать ещё заявку
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
