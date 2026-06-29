'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, apiPost } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Plus, Trash2, CheckCircle2, X, Search } from 'lucide-react';

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
  // Bug fix 2026-06-02: тип недвижимости должен соответствовать проекту.
  // Зорге 9 — апарт-комплекс, Серебряный бор — жилой (квартиры).
  // Коммерческие площади есть в обоих корпусах.
  const propertyTypesByProject: Record<string, Array<'Квартира' | 'Апартаменты' | 'Коммерческая'>> = {
    ZORGE9: ['Апартаменты', 'Коммерческая'],
    SILVER_BOR: ['Квартира', 'Коммерческая'],
  };
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState(''); // правка 2026-05-15: необязательное
  const [lastName, setLastName] = useState('');
  const [project, setProject] = useState('ZORGE9');
  // Тип недвижимости зависит от проекта: Зорге 9 — апартаменты, Серебряный
  // бор (Берзарина 37) — квартиры. Коммерческие помещения есть в обоих.
  // Bug fix 2026-06-02: «Квартира» для Зорге была доступна — это ошибка.
  const [propertyType, setPropertyType] = useState<'Квартира' | 'Апартаменты' | 'Коммерческая'>('Апартаменты');

  // При смене проекта — переключаем тип, если текущее значение
  // не входит в допустимые для проекта.
  useEffect(() => {
    const allowed = propertyTypesByProject[project] || [];
    if (allowed.length && !allowed.includes(propertyType)) {
      setPropertyType(allowed[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);
  const [roomsCount, setRoomsCount] = useState<string>(''); // студия/1/2/3/4+
  const [sqm, setSqm] = useState('');
  const [amount, setAmount] = useState(''); // raw digits
  const [participants, setParticipants] = useState<Participant[]>([]);
  // Правка 2026-05-22: новые поля по КБ3 (amo интеграция).
  // 2026-06-11: убрано поле clientRegion — лишняя информация для брокера.
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

  // 2026-06-19: для координатора — выбор реального брокера, ведущего клиента.
  // У обычного брокера responsibleBroker = он сам (поля readonly как раньше).
  const isCoordinator = !!(broker as any)?.isCoordinator;
  const [respSearch, setRespSearch] = useState('');
  const [respOptions, setRespOptions] = useState<Array<{ id: string; fullName: string; phone: string }>>([]);
  const [respLoading, setRespLoading] = useState(false);
  const [respSelected, setRespSelected] = useState<{ id: string; fullName: string; phone: string } | null>(null);
  const [respOpen, setRespOpen] = useState(false);
  // 2026-06-29: модалка «создать нового брокера» (доступна координатору
  // когда поиск не дал результата).
  const [createBrokerOpen, setCreateBrokerOpen] = useState(false);
  const [createBrokerLoading, setCreateBrokerLoading] = useState(false);
  const [createBrokerError, setCreateBrokerError] = useState<{ field?: string; message: string } | null>(null);
  const [newBrokerName, setNewBrokerName] = useState('');
  const [newBrokerPhone, setNewBrokerPhone] = useState(''); // 10 цифр без +7
  const [newBrokerEmail, setNewBrokerEmail] = useState('');
  const [coordAgencies, setCoordAgencies] = useState<Array<{ id: string; name: string; inn: string; isPrimary: boolean }>>([]);
  const [newBrokerAgencyId, setNewBrokerAgencyId] = useState('');

  useEffect(() => {
    if (!isCoordinator) return;
    const q = respSearch.trim();
    if (q.length > 0 && q.length < 2) return;
    setRespLoading(true);
    const t = setTimeout(() => {
      apiGet(`/clients/agency-colleagues${q ? `?search=${encodeURIComponent(q)}` : ''}`)
        .then((d: any) => setRespOptions(d?.brokers || []))
        .catch(() => setRespOptions([]))
        .finally(() => setRespLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [respSearch, isCoordinator]);

  // 2026-06-29: загрузить список агентств координатора при открытии модалки.
  useEffect(() => {
    if (!createBrokerOpen || !isCoordinator) return;
    apiGet(`/clients/coordinator/agencies`)
      .then((d: any) => {
        const list = d?.agencies || [];
        setCoordAgencies(list);
        // Авто-выбор primary если он один.
        const primary = list.find((a: any) => a.isPrimary) || list[0];
        if (primary && !newBrokerAgencyId) setNewBrokerAgencyId(primary.id);
      })
      .catch(() => setCoordAgencies([]));
  }, [createBrokerOpen, isCoordinator]);

  // Открыть модалку — предзаполнить телефон из поиска (если был ввод цифр).
  const openCreateBrokerModal = () => {
    const digitsFromSearch = respSearch.replace(/\D/g, '');
    if (digitsFromSearch.length === 10) {
      setNewBrokerPhone(digitsFromSearch);
    } else if (digitsFromSearch.length === 11 && (digitsFromSearch[0] === '7' || digitsFromSearch[0] === '8')) {
      setNewBrokerPhone(digitsFromSearch.slice(1));
    }
    setCreateBrokerError(null);
    setCreateBrokerOpen(true);
  };

  // Submit создания нового брокера.
  const handleCreateBroker = async () => {
    setCreateBrokerError(null);
    if (!newBrokerName.trim()) {
      setCreateBrokerError({ field: 'fullName', message: 'Введите ФИО' });
      return;
    }
    if (newBrokerPhone.length !== 10) {
      setCreateBrokerError({ field: 'phone', message: 'Введите 10 цифр номера' });
      return;
    }
    if (newBrokerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newBrokerEmail)) {
      setCreateBrokerError({ field: 'email', message: 'Неверный формат email' });
      return;
    }
    if (!newBrokerAgencyId) {
      setCreateBrokerError({ field: 'agencyId', message: 'Выберите агентство' });
      return;
    }
    setCreateBrokerLoading(true);
    try {
      const r: any = await apiPost('/clients/coordinator/create-broker', {
        fullName: newBrokerName.trim(),
        phone: '+7' + newBrokerPhone,
        email: newBrokerEmail.trim() || undefined,
        agencyId: newBrokerAgencyId,
      });
      // Успех. Выбираем нового (или найденного) брокера как ответственного.
      if (r?.broker) {
        setRespSelected({ id: r.broker.id, fullName: r.broker.fullName, phone: r.broker.phone });
        setRespOpen(false);
        setCreateBrokerOpen(false);
        // Очищаем форму
        setNewBrokerName('');
        setNewBrokerPhone('');
        setNewBrokerEmail('');
      }
    } catch (e: any) {
      const raw = e?.response?.data || e;
      setCreateBrokerError({
        field: raw?.field,
        message: raw?.message || e?.message || 'Не удалось создать брокера',
      });
    } finally {
      setCreateBrokerLoading(false);
    }
  };

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
    if (!phoneOk || !firstName.trim() || !sqm || !amount || !brokerAgency?.inn || (isCoordinator && !respSelected)) {
      setError(isCoordinator && !respSelected
        ? 'Выберите ответственного брокера, ведущего клиента'
        : 'Заполните все обязательные поля (отмечены красным)');
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
      ...(isCoordinator && respSelected ? { responsibleBrokerId: respSelected.id } : {}),
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
    setPropertyType('Апартаменты');
    setRoomsCount('');
    setSqm('');
    setAmount('');
    setParticipants([]);
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
  const canSubmit = phoneValid && !!firstName && !!sqm && !!amount && !!brokerAgency?.inn && (!isCoordinator || !!respSelected);

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

          {/* 2026-06-15 (правки Ксении): кнопку «Добавить участника» подняли
              к блоку с ФИО клиента, чтобы её было видно сразу — не
              приходится прокручивать форму до конца. */}
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
                {(propertyTypesByProject[project] || []).map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
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

          {/* Дополнительные поля для amoCRM-лида (правка 2026-05-22, КБ3).
              2026-06-11: убран dev-маркер «(заполнится в amoCRM)» и поле
              «Регион клиента» — лишняя информация для брокера. */}
          <div className="border-t border-border pt-4 mt-2">
            <div className="text-xs font-semibold text-text-muted uppercase mb-3">Доп. информация о клиенте</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
            </div>
          </div>

          <div className="pt-4 border-t border-border">
            {isCoordinator ? (
              <div className="relative">
                <label className="label">
                  Ответственный брокер <span className="text-error">*</span>
                </label>
                <div className="text-xs text-text-muted mb-2">
                  Найдите брокера, который реально работает с клиентом. Поиск по ФИО или телефону по всей базе.
                </div>
                {respSelected ? (
                  <div className="flex items-center justify-between bg-surface-secondary rounded-lg p-3">
                    <div>
                      <div className="font-medium">{respSelected.fullName}</div>
                      <div className="text-xs text-text-muted">{respSelected.phone}</div>
                    </div>
                    <button
                      type="button"
                      className="text-xs text-accent hover:underline"
                      onClick={() => { setRespSelected(null); setRespSearch(''); setRespOpen(true); }}
                    >
                      Сменить
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="relative">
                      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                      <input
                        type="text"
                        className={`input pl-10 ${attempted && !respSelected ? 'field-invalid' : ''}`}
                        placeholder="Найти по ФИО или телефону…"
                        value={respSearch}
                        onChange={(e) => { setRespSearch(e.target.value); setRespOpen(true); }}
                        onFocus={() => setRespOpen(true)}
                      />
                    </div>
                    {respOpen && (
                      <div className="absolute z-10 left-0 right-0 bg-surface border border-border rounded-lg mt-1 max-h-60 overflow-y-auto shadow-lg">
                        {respLoading && <div className="p-3 text-text-muted text-sm">Поиск…</div>}
                        {!respLoading && respOptions.length === 0 && (
                          <div className="p-3 text-text-muted text-sm space-y-2">
                            <div>
                              Брокеров не найдено. Проверьте формат телефона (можно вводить +7, 8 или просто цифры — система сама нормализует).
                            </div>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={openCreateBrokerModal}
                            >
                              + Создать нового брокера
                            </button>
                          </div>
                        )}
                        {!respLoading && respOptions.map((b) => (
                          <button
                            key={b.id}
                            type="button"
                            className="w-full text-left px-3 py-2 hover:bg-surface-secondary"
                            onClick={() => { setRespSelected(b); setRespOpen(false); setRespSearch(''); }}
                          >
                            <div className="font-medium text-sm">{b.fullName}</div>
                            <div className="text-xs text-text-muted">{b.phone}</div>
                          </button>
                        ))}
                      </div>
                    )}
                    {attempted && !respSelected && (
                      <div className="text-xs text-error mt-1">Выберите ответственного брокера</div>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="label">ФИО брокера</label>
                  <input type="text" className="input bg-surface-secondary" value={brokerNameDisplay} readOnly />
                </div>
                <div>
                  <label className="label">Телефон брокера</label>
                  <input type="text" className="input bg-surface-secondary" value={brokerPhoneDisplay} readOnly />
                </div>
              </div>
            )}
          </div>

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

      {/* 2026-06-29: модалка «Создать нового брокера» (доступна координатору). */}
      {createBrokerOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={() => !createBrokerLoading && setCreateBrokerOpen(false)}
        >
          <div
            className="bg-surface rounded-xl max-w-md w-full p-6 relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="absolute top-4 right-4 text-text-muted hover:text-text"
              onClick={() => !createBrokerLoading && setCreateBrokerOpen(false)}
              disabled={createBrokerLoading}
            >
              ×
            </button>
            <h2 className="text-lg font-bold mb-1">Создать нового брокера</h2>
            <p className="text-xs text-text-muted mb-4">
              Будет создан аккаунт. Брокер получит email с приглашением и сможет войти, сбросив пароль через «Забыли пароль».
            </p>

            <div className="space-y-3">
              <div>
                <label className="label">ФИО <span className="text-error">*</span></label>
                <input
                  type="text"
                  className={`input ${createBrokerError?.field === 'fullName' ? 'border-error' : ''}`}
                  placeholder="Иванов Иван Иванович"
                  value={newBrokerName}
                  onChange={(e) => setNewBrokerName(e.target.value)}
                  disabled={createBrokerLoading}
                />
                {createBrokerError?.field === 'fullName' && (
                  <div className="text-xs text-error mt-1">{createBrokerError.message}</div>
                )}
              </div>

              <div>
                <label className="label">Телефон <span className="text-error">*</span></label>
                <div className="flex">
                  <span className="inline-flex items-center px-3 bg-surface-secondary border border-r-0 border-border rounded-l text-text-muted text-sm">+7</span>
                  <input
                    type="tel"
                    className={`input rounded-l-none ${createBrokerError?.field === 'phone' ? 'border-error' : ''}`}
                    placeholder="9991234567"
                    value={newBrokerPhone}
                    onChange={(e) => setNewBrokerPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    maxLength={10}
                    disabled={createBrokerLoading}
                  />
                </div>
                {createBrokerError?.field === 'phone' && (
                  <div className="text-xs text-error mt-1">{createBrokerError.message}</div>
                )}
              </div>

              <div>
                <label className="label">Email <span className="text-text-muted">(необязательно)</span></label>
                <input
                  type="email"
                  className={`input ${createBrokerError?.field === 'email' ? 'border-error' : ''}`}
                  placeholder="broker@example.ru"
                  value={newBrokerEmail}
                  onChange={(e) => setNewBrokerEmail(e.target.value)}
                  disabled={createBrokerLoading}
                />
                <div className="text-xs text-text-muted mt-1">
                  Без email брокер не сможет получить ссылку для входа.
                </div>
                {createBrokerError?.field === 'email' && (
                  <div className="text-xs text-error mt-1">{createBrokerError.message}</div>
                )}
              </div>

              <div>
                <label className="label">Агентство <span className="text-error">*</span></label>
                <select
                  className={`input ${createBrokerError?.field === 'agencyId' ? 'border-error' : ''}`}
                  value={newBrokerAgencyId}
                  onChange={(e) => setNewBrokerAgencyId(e.target.value)}
                  disabled={createBrokerLoading || coordAgencies.length === 0}
                >
                  {coordAgencies.length === 0 && <option value="">— загрузка —</option>}
                  {coordAgencies.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} (ИНН {a.inn}){a.isPrimary ? ' • основное' : ''}
                    </option>
                  ))}
                </select>
                {createBrokerError?.field === 'agencyId' && (
                  <div className="text-xs text-error mt-1">{createBrokerError.message}</div>
                )}
              </div>

              {createBrokerError && !createBrokerError.field && (
                <div className="p-2 bg-error/20 text-error rounded text-sm">{createBrokerError.message}</div>
              )}

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  className="btn btn-secondary flex-1"
                  onClick={() => setCreateBrokerOpen(false)}
                  disabled={createBrokerLoading}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="btn btn-primary flex-1"
                  onClick={handleCreateBroker}
                  disabled={createBrokerLoading}
                >
                  {createBrokerLoading ? 'Создание…' : 'Создать'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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
