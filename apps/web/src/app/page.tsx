'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

function PhoneInput({ value, onChange, style }: { value: string; onChange: (v: string) => void; style?: React.CSSProperties }) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
    onChange(digits);
  };
  return (
    <div style={{display:'flex',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,overflow:'hidden',...style}}>
      <span style={{padding:'12px 12px 12px 16px',fontSize:14,color:'#8a8680',background:'rgba(0,0,0,0.03)',borderRight:'1px solid rgba(0,0,0,0.08)',userSelect:'none'}}>+7</span>
      <input
        type="tel"
        placeholder="9991234567"
        value={value}
        onChange={handleChange}
        maxLength={10}
        style={{flex:1,padding:'12px 16px',border:'none',fontSize:14,outline:'none',width:'100%'}}
      />
    </div>
  );
}

function AuthModal({ mode, onClose, onSwitch, onSuccess }: { mode: 'login' | 'register'; onClose: () => void; onSwitch: () => void; onSuccess: () => void }) {
  const [phoneDigits, setPhoneDigits] = useState('');
  const [password, setPassword] = useState('');
  const [lastName, setLastName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [email, setEmail] = useState('');
  const [agencyName, setAgencyName] = useState('');
  const [inn, setInn] = useState('');
  const [innType, setInnType] = useState<'PERSONAL' | 'AGENCY'>('AGENCY');
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { login } = useAuth();

  const fullPhone = '+7' + phoneDigits;

  const doLogin = async (phone: string, pw: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password: pw }),
    });
    const data = await res.json();
    if (res.ok) { login(data.accessToken, data.refreshToken); onSuccess(); }
    else throw new Error(data.message || 'Ошибка входа');
  };

  const handleLogin = async () => {
    setLoading(true); setError('');
    try { await doLogin(fullPhone, password); }
    catch (e: any) { setError(e.message || 'Ошибка соединения'); }
    setLoading(false);
  };

  const handleForgot = async () => {
    setLoading(true); setError('');
    try {
      await fetch('/api/auth/forgot-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setForgotSent(true);
    } catch { setError('Ошибка соединения'); }
    setLoading(false);
  };

  const handleRegister = async () => {
    if (password.length < 8) {
      setError('Пароль должен быть не менее 8 символов');
      return;
    }
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: fullPhone,
          lastName, firstName, middleName: middleName || undefined,
          email: email || undefined,
          password,
          inn: inn || undefined,
          innType: inn ? innType : undefined,
          agencyName: agencyName || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) { await doLogin(fullPhone, password); }
      else setError(data.message || 'Ошибка регистрации');
    } catch (e: any) { setError(e.message || 'Ошибка соединения'); }
    setLoading(false);
  };

  return (
    <div style={{position:'fixed',inset:0,zIndex:1000,background:'rgba(0,0,0,0.5)',display:'flex',alignItems:'center',justifyContent:'center',padding:20}} onClick={onClose}>
      <div style={{background:'#fff',borderRadius:8,maxWidth:420,width:'100%',padding:'36px 32px',position:'relative'}} onClick={e=>e.stopPropagation()}>
        <button onClick={onClose} style={{position:'absolute',top:16,right:16,background:'none',border:'none',fontSize:20,cursor:'pointer',color:'#8a8680'}}>&times;</button>
        <h2 style={{fontSize:24,fontWeight:700,marginBottom:4,color:'#1a1a1a'}}>
          {forgotMode ? 'Восстановление пароля' : mode === 'login' ? 'Вход в кабинет' : 'Регистрация'}
        </h2>
        <p style={{fontSize:13,color:'#8a8680',marginBottom:24}}>
          {forgotMode ? 'Введите email для получения ссылки' : mode === 'login' ? 'Введите данные для входа' : 'Создайте аккаунт партнёра'}
        </p>

        {error && <div style={{padding:'10px 14px',background:'rgba(220,60,60,0.1)',color:'#c33',borderRadius:4,fontSize:13,marginBottom:16}}>{error}</div>}

        {forgotMode ? (
          forgotSent ? (
            <div style={{padding:'14px',background:'rgba(60,140,80,0.1)',color:'#3a8a5c',borderRadius:4,fontSize:13}}>
              Если email зарегистрирован — на него отправлена ссылка для восстановления. Проверьте почту.
            </div>
          ) : (
            <div style={{display:'flex',flexDirection:'column',gap:12}}>
              <input placeholder="Email" type="email" value={email} onChange={e=>setEmail(e.target.value)}
                style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
              <button onClick={handleForgot} disabled={loading || !email}
                style={{padding:'14px',background:'#1a1a1a',color:'#fff',border:'none',borderRadius:50,fontSize:13,fontWeight:700,letterSpacing:1,cursor:'pointer',opacity:loading?0.6:1}}>
                {loading ? 'Отправка...' : 'ПОЛУЧИТЬ ССЫЛКУ'}
              </button>
            </div>
          )
        ) : (
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            {mode === 'register' && (
              <>
                <input placeholder="Фамилия *" value={lastName} onChange={e=>setLastName(e.target.value)}
                  style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
                <input placeholder="Имя *" value={firstName} onChange={e=>setFirstName(e.target.value)}
                  style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
                <input placeholder="Отчество (необязательно)" value={middleName} onChange={e=>setMiddleName(e.target.value)}
                  style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
                <PhoneInput value={phoneDigits} onChange={setPhoneDigits} />
                <input placeholder="Email" type="email" value={email} onChange={e=>setEmail(e.target.value)}
                  style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
                <input placeholder="Название агентства" value={agencyName} onChange={e=>setAgencyName(e.target.value)}
                  style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
                <input placeholder="ИНН (10 или 12 цифр)" inputMode="numeric" value={inn}
                  onChange={e=>setInn(e.target.value.replace(/\D/g,'').slice(0,12))}
                  style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
                <div style={{display:'flex',gap:16,fontSize:13,color:'#1a1a1a'}}>
                  <label style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer'}}>
                    <input type="radio" name="innType" checked={innType==='PERSONAL'} onChange={()=>setInnType('PERSONAL')} />
                    Личный ИНН
                  </label>
                  <label style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer'}}>
                    <input type="radio" name="innType" checked={innType==='AGENCY'} onChange={()=>setInnType('AGENCY')} />
                    ИНН агентства
                  </label>
                </div>
              </>
            )}
            {mode === 'login' && (
              <PhoneInput value={phoneDigits} onChange={setPhoneDigits} />
            )}
            <input placeholder={mode === 'register' ? 'Пароль (минимум 8 символов)' : 'Пароль'} type="password" value={password} onChange={e=>setPassword(e.target.value)}
              onKeyDown={e=>e.key==='Enter' && (mode==='login' ? handleLogin() : handleRegister())}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            <button onClick={mode==='login' ? handleLogin : handleRegister}
              disabled={
                loading ||
                !password ||
                (mode === 'login'
                  ? phoneDigits.length !== 10
                  : (!firstName || !lastName || !email || phoneDigits.length !== 10 || (inn.length !== 10 && inn.length !== 12) || password.length < 8))
              }
              style={{padding:'14px',background:'#1a1a1a',color:'#fff',border:'none',borderRadius:50,fontSize:13,fontWeight:700,letterSpacing:1,cursor:'pointer',opacity:loading?0.6:1}}>
              {loading ? 'Подождите...' : mode==='login' ? 'ВОЙТИ' : 'ЗАРЕГИСТРИРОВАТЬСЯ'}
            </button>
          </div>
        )}

        <div style={{marginTop:20,textAlign:'center',fontSize:13,color:'#8a8680'}}>
          {forgotMode ? (
            <button onClick={()=>{ setForgotMode(false); setForgotSent(false); setError(''); }}
              style={{background:'none',border:'none',color:'#B4936F',cursor:'pointer',fontWeight:600,fontSize:13}}>
              ← Назад ко входу
            </button>
          ) : mode === 'login' ? (
            <>
              <div><span>Нет аккаунта? <button onClick={onSwitch} style={{background:'none',border:'none',color:'#B4936F',cursor:'pointer',fontWeight:600,fontSize:13}}>Регистрация</button></span></div>
              <div style={{marginTop:10}}>
                <button onClick={()=>{ setForgotMode(true); setError(''); }} style={{background:'none',border:'none',color:'#B4936F',cursor:'pointer',fontSize:13,textDecoration:'underline'}}>
                  Забыли пароль?
                </button>
              </div>
            </>
          ) : (
            <span>Уже есть аккаунт? <button onClick={onSwitch} style={{background:'none',border:'none',color:'#B4936F',cursor:'pointer',fontWeight:600,fontSize:13}}>Войти</button></span>
          )}
        </div>
      </div>
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{borderBottom:'1px solid var(--bw)',background:'var(--white)'}}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width:'100%', padding:'18px 20px', display:'flex', alignItems:'center', justifyContent:'space-between',
          background:'none', border:'none', cursor:'pointer', textAlign:'left',
          fontSize:15, fontWeight:600, color:'var(--black)', fontFamily:'inherit',
        }}
        aria-expanded={open}
      >
        <span style={{paddingRight:16}}>{q}</span>
        <span style={{
          flexShrink:0, width:28, height:28, borderRadius:'50%', border:'1px solid var(--bw2)',
          display:'flex', alignItems:'center', justifyContent:'center',
          color:'var(--gold)', fontSize:18, lineHeight:1,
          transform: open ? 'rotate(45deg)' : 'none', transition:'transform .2s',
        }}>+</span>
      </button>
      {open && (
        <div style={{padding:'0 20px 20px',fontSize:14,color:'var(--light)',lineHeight:1.7,fontWeight:300}}>
          {a}
        </div>
      )}
    </div>
  );
}

function ContactFormModal({ onClose, source = 'landing-contact', defaultMessage = '', eventId, title = 'Связаться с нами' }: { onClose: () => void; source?: string; defaultMessage?: string; eventId?: string; title?: string }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState(defaultMessage);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const formatPhone = (v: string) => {
    const d = v.replace(/\D/g, '').slice(0, 11);
    if (!d) return '';
    return (d.startsWith('7') || d.startsWith('8')) ? '+7' + d.slice(1) : '+' + d;
  };

  const submit = async () => {
    setError('');
    if (!name.trim() || name.trim().length < 2) return setError('Введите имя');
    if (!phone || phone.replace(/\D/g, '').length < 10) return setError('Введите телефон');

    setLoading(true);
    try {
      const res = await fetch('/api/public/cms/contact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          phone: formatPhone(phone),
          email: email || undefined,
          message: message || undefined,
          source,
          eventId,
        }),
      });
      if (res.ok) setSent(true);
      else {
        const d = await res.json().catch(() => ({}));
        setError(d.message || 'Ошибка отправки');
      }
    } catch { setError('Ошибка соединения'); }
    setLoading(false);
  };

  return (
    <div style={{position:'fixed',inset:0,zIndex:1000,background:'rgba(0,0,0,0.5)',display:'flex',alignItems:'center',justifyContent:'center',padding:20}} onClick={onClose}>
      <div style={{background:'#fff',borderRadius:8,maxWidth:460,width:'100%',padding:'36px 32px',position:'relative'}} onClick={e=>e.stopPropagation()}>
        <button onClick={onClose} style={{position:'absolute',top:16,right:16,background:'none',border:'none',fontSize:20,cursor:'pointer',color:'#8a8680'}}>&times;</button>
        <h2 style={{fontSize:22,fontWeight:700,marginBottom:4,color:'#1a1a1a'}}>{title}</h2>
        <p style={{fontSize:13,color:'#8a8680',marginBottom:24}}>Менеджер свяжется с вами в течение часа</p>

        {error && <div style={{padding:'10px 14px',background:'rgba(220,60,60,0.1)',color:'#c33',borderRadius:4,fontSize:13,marginBottom:16}}>{error}</div>}

        {sent ? (
          <div style={{padding:'14px',background:'rgba(60,140,80,0.1)',color:'#3a8a5c',borderRadius:4,fontSize:14,textAlign:'center'}}>
            <div style={{fontWeight:700,marginBottom:4}}>✓ Заявка принята</div>
            <div style={{fontSize:13}}>Мы свяжемся с вами в ближайшее время.</div>
          </div>
        ) : (
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            <input placeholder="Ваше имя *" value={name} onChange={e=>setName(e.target.value)}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            <input placeholder="Телефон * (+79991234567)" type="tel" value={phone} onChange={e=>setPhone(e.target.value)}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            <input placeholder="Email (необязательно)" type="email" value={email} onChange={e=>setEmail(e.target.value)}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            <textarea placeholder="Сообщение" rows={3} value={message} onChange={e=>setMessage(e.target.value)}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none',resize:'vertical',fontFamily:'inherit'}} />
            <button onClick={submit} disabled={loading}
              style={{padding:'14px',background:'#B4936F',color:'#fff',border:'none',borderRadius:50,fontSize:13,fontWeight:700,letterSpacing:1,cursor:'pointer',opacity:loading?0.6:1}}>
              {loading ? 'Отправка...' : 'ОТПРАВИТЬ'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function QuickFixModal({ onClose }: { onClose: () => void }) {
  const [clientPhone, setClientPhone] = useState('');
  const [clientFullName, setClientFullName] = useState('');
  const [brokerPhone, setBrokerPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<any>(null);

  const formatPhone = (v: string) => {
    const d = v.replace(/\D/g, '').slice(0, 11);
    if (!d) return '';
    return (d.startsWith('7') || d.startsWith('8')) ? '+7' + d.slice(1) : '+' + d;
  };

  const handleSubmit = async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/public/quick-fix', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientPhone: formatPhone(clientPhone),
          clientFullName,
          brokerPhone: formatPhone(brokerPhone),
        }),
      });
      const data = await res.json();
      if (res.ok) setResult(data);
      else setError(data.message || 'Ошибка фиксации');
    } catch { setError('Ошибка соединения'); }
    setLoading(false);
  };

  return (
    <div style={{position:'fixed',inset:0,zIndex:1000,background:'rgba(0,0,0,0.5)',display:'flex',alignItems:'center',justifyContent:'center',padding:20}} onClick={onClose}>
      <div style={{background:'#fff',borderRadius:8,maxWidth:460,width:'100%',padding:'36px 32px',position:'relative'}} onClick={e=>e.stopPropagation()}>
        <button onClick={onClose} style={{position:'absolute',top:16,right:16,background:'none',border:'none',fontSize:20,cursor:'pointer',color:'#8a8680'}}>&times;</button>
        <h2 style={{fontSize:24,fontWeight:700,marginBottom:4,color:'#1a1a1a'}}>Моментальная фиксация</h2>
        <p style={{fontSize:13,color:'#8a8680',marginBottom:24}}>Зафиксируйте клиента за собой прямо сейчас, без входа в кабинет</p>

        {error && <div style={{padding:'10px 14px',background:'rgba(220,60,60,0.1)',color:'#c33',borderRadius:4,fontSize:13,marginBottom:16}}>{error}</div>}

        {result ? (
          <div style={{padding:'14px',background:'rgba(60,140,80,0.1)',color:'#3a8a5c',borderRadius:4,fontSize:14,textAlign:'center'}}>
            <div style={{fontWeight:700,marginBottom:4}}>✓ {result.status === 'EXISTS' ? 'Клиент уже зафиксирован за вами' : 'Клиент успешно зафиксирован'}</div>
            <div style={{fontSize:13}}>{result.message}</div>
          </div>
        ) : (
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            <input placeholder="Телефон клиента (+79991234567)" type="tel" value={clientPhone}
              onChange={e=>setClientPhone(e.target.value)}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            <input placeholder="ФИО клиента" value={clientFullName}
              onChange={e=>setClientFullName(e.target.value)}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            <input placeholder="Ваш телефон (+79991234567)" type="tel" value={brokerPhone}
              onChange={e=>setBrokerPhone(e.target.value)}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            <button onClick={handleSubmit}
              disabled={loading || !clientPhone || !clientFullName || !brokerPhone}
              style={{padding:'14px',background:'#B4936F',color:'#fff',border:'none',borderRadius:50,fontSize:13,fontWeight:700,letterSpacing:1,cursor:'pointer',opacity:loading?0.6:1}}>
              {loading ? 'Отправка...' : 'ЗАФИКСИРОВАТЬ'}
            </button>
            <p style={{fontSize:12,color:'#8a8680',textAlign:'center',marginTop:4}}>
              Ваш номер должен быть зарегистрирован в ЛК. Уникальность действует 30 дней.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function renderAccent(text: string | undefined | null, accent?: string | null): React.ReactNode {
  if (!text) return null;
  if (!accent || !text.includes(accent)) return text;
  const i = text.indexOf(accent);
  return (<>{text.slice(0, i)}<em>{accent}</em>{text.slice(i + accent.length)}</>);
}

const DEFAULT_HERO = {
  tag: 'Партнёрская программа',
  title: 'Доход растёт вместе с объёмом продаж агентства',
  titleAccent: 'продаж агентства',
  description: 'Суммируем сделки по Зорге 9 и Кварталу Серебряный Бор — вы быстрее выходите на более высокий уровень комиссии. До 8% по Зорге 9 и до 6,25% по Серебряному Бору.',
  stats: [
    { number: 'до 8%', label: 'Максимальная ставка по Зорге 9' },
    { number: '7 дней', label: 'Выплата вознаграждения' },
    { number: '30 дней', label: 'Срок уникальности клиента' },
    { number: '2', label: 'Активных проекта' },
  ],
};
const DEFAULT_ADVANTAGES = {
  tag: 'Преимущества',
  title: 'Почему брокеры выбирают нас',
  titleAccent: 'выбирают нас',
  items: [
    { title: 'Выделенный отдел партнёров', description: 'Сопровождение на всех этапах сделки.' },
    { title: 'Выделенная линия', description: 'Ответ без ожидания с 9:00 до 21:00.' },
    { title: 'Быстрые выплаты', description: 'Вознаграждение — до 7 рабочих дней.' },
    { title: 'Высокая комиссия', description: 'До 8% — одна из лучших на рынке.' },
    { title: 'Партнёрство', description: 'Работаем на общий результат.' },
    { title: 'Обучение', description: 'Брокер-туры для быстрого старта продаж.' },
  ],
};
const DEFAULT_COMMISSION = {
  tag: 'Комиссия и условия выплаты',
  title: 'Прогрессивная шкала вознаграждения',
  titleAccent: 'шкала',
  subtitle: 'Метраж суммируется по обоим проектам в рамках одного агентства. Действует с 1 января по 30 июня 2026 года.',
  // Per-project levels (preferred). Fallback to "levels" if absent.
  levelsByProject: {
    ZORGE9: [
      { name: 'Start', range: '0–59 м²', rate: '5,0%', active: false },
      { name: 'Basic', range: '60–119 м²', rate: '5,5%', active: false },
      { name: 'Strong', range: '120–199 м²', rate: '6,0%', active: true },
      { name: 'Premium', range: '200–319 м²', rate: '6,5%', active: false },
      { name: 'Elite', range: '320–499 м²', rate: '7,0%', active: false },
      { name: 'Champion', range: '500–699 м²', rate: '7,5%', active: false },
      { name: 'Legend', range: '700+ м²', rate: '8,0%', active: false },
    ],
    SILVER_BOR: [
      { name: 'Start', range: '0–47 м²', rate: '5,0%', active: false },
      { name: 'Basic', range: '48–95 м²', rate: '5,25%', active: false },
      { name: 'Strong', range: '96–170 м²', rate: '5,5%', active: true },
      { name: 'Premium', range: '171–279 м²', rate: '5,75%', active: false },
      { name: 'Elite', range: '280–399 м²', rate: '6,0%', active: false },
      { name: 'Champion', range: '400+ м²', rate: '6,25%', active: false },
    ],
  },
  // Legacy fallback
  levels: [
    { name: 'Start', range: '0–59 м²', rate: '5,0%', active: false },
    { name: 'Basic', range: '60–119 м²', rate: '5,5%', active: false },
    { name: 'Strong', range: '120–199 м²', rate: '6,0%', active: true },
    { name: 'Premium', range: '200–319 м²', rate: '6,5%', active: false },
    { name: 'Elite', range: '320–499 м²', rate: '7,0%', active: false },
    { name: 'Champion', range: '500–699 м²', rate: '7,5%', active: false },
    { name: 'Legend', range: '700+ м²', rate: '8,0%', active: false },
  ],
  cards: [
    { title: 'Условия выплаты', text: 'Вознаграждение выплачивается в течение 7 рабочих дней после оплаты клиентом. ПВ ≥ 50% (Зорге 9) или ≥ 30% (Серебряный Бор) — единовременно.' },
    { title: 'Квартальный бонус', text: 'При уровне Strong+ несколько кварталов подряд: +0,1% → +0,15% → +0,2% → +0,25% (максимум). Обнуляется при отсутствии продаж в квартале.' },
    { title: 'Бонус за скорость', text: '+0,1% к ставке, если от заявки клиента до платной брони проходит не более 10 рабочих дней. Действует на оба проекта.' },
    { title: 'Годовой бонус', text: '100 000 ₽ + памятный кубок за минимум одну сделку раз в 2 месяца в течение года.' },
    { title: 'Рассрочка и ипотека', text: 'При рассрочке —0,5% от базовой ставки. Субсидированная ипотека — 4% (м² идут в общий зачёт).' },
    { title: 'Коммерческие помещения', text: 'Продажа: помещения и фитнес — 3%, отдельно стоящие здания — 2%. Аренда: ритейл — 100% мес. платежа, фитнес/офис — 50%.' },
    { title: 'Реферальная программа', text: 'Дополнительное вознаграждение за привлечение новых партнёров в программу.' },
  ],
};
const DEFAULT_CONTACT = {
  tag: 'Команда',
  title: 'Всегда на связи',
  titleAccent: 'на связи',
  description: 'В наши бизнес-процессы заложена тесная коммуникация с партнёрами. Горячая линия по работе с партнёрами работает каждый день с 9:00 до 21:00.',
  blockTitle: 'Горячая линия по работе с партнёрами',
  phone: '+7 (499) 226-22-49',
  phoneHours: 'Ежедневно с 9:00 до 21:00',
  email: 'broker@stmichael.ru',
  telegram: 'https://t.me/stmichaelBroker',
  manager: {
    name: 'Ксения Цепляева',
    role: 'Руководитель отдела по работе с партнёрами',
    phone: '+7 (906) 061-78-00',
  },
};
const DEFAULT_PROJECTS = [
  { id: 'p1', slug: 'zorge9', tag: 'Приоритетный проект', name: 'Зорге', subtitle: '9', description: 'Апартаменты бизнес-класса у метро Полежаевская. 3 корпуса, архитектура в стиле Арт-Москва. От 270 000 р/м2.', ctaText: 'Смотреть каталог', ctaHref: null },
  { id: 'p2', slug: 'silver-bor', tag: 'Новый проект', name: 'Квартал', subtitle: 'Серебряный Бор', description: 'Жилой комплекс премиум-класса рядом с Серебряным Бором. Уникальная локация и инфраструктура.', ctaText: 'Смотреть каталог', ctaHref: null },
];

const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function formatEventDate(iso: string): { day: string; mon: string } {
  const d = new Date(iso);
  return { day: String(d.getDate()).padStart(2, '0'), mon: MONTHS_RU[d.getMonth()] };
}
function formatEventMeta(iso: string, location: string | null, isOnline: boolean): string {
  const d = new Date(iso);
  const day = d.getDate();
  const mon = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'][d.getMonth()];
  const dow = ['вс','пн','вт','ср','чт','пт','сб'][d.getDay()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const where = isOnline ? 'Онлайн' : (location || '');
  const base = `${day} ${mon}, ${dow}, ${hh}:${mm}`;
  return where ? `${base}. ${where}` : base;
}

export default function LandingPage() {
  const [authModal, setAuthModal] = useState<'login' | 'register' | null>(null);
  const [quickFixOpen, setQuickFixOpen] = useState(false);
  const [contactModal, setContactModal] = useState<{ open: boolean; source?: string; eventId?: string; title?: string; defaultMessage?: string }>({ open: false });
  const [commissionProject, setCommissionProject] = useState<'ZORGE9' | 'SILVER_BOR'>('ZORGE9');
  const [hero, setHero] = useState<any>(DEFAULT_HERO);
  const [advantages, setAdvantages] = useState<any>(DEFAULT_ADVANTAGES);
  const [commission, setCommission] = useState<any>(DEFAULT_COMMISSION);
  const [contact, setContact] = useState<any>(DEFAULT_CONTACT);
  const [projects, setProjects] = useState<any[]>(DEFAULT_PROJECTS);
  const [events, setEvents] = useState<any[]>([]);
  const [promos, setPromos] = useState<any[]>([]);
  const [promoIdx, setPromoIdx] = useState(0);
  const [cooperationDocs, setCooperationDocs] = useState<any[]>([]);
  const [analyticsDocs, setAnalyticsDocs] = useState<any[]>([]);
  const [marketingDocs, setMarketingDocs] = useState<any[]>([]);
  const { broker } = useAuth();
  const router = useRouter();

  const handleCabinet = () => { if (broker) router.push('/fixation'); else setAuthModal('login'); };
  const handleRegister = () => { if (broker) router.push('/fixation'); else setAuthModal('register'); };
  const handleProjectClick = (p: any) => { if (p.ctaHref) window.open(p.ctaHref, '_blank'); else handleCabinet(); };

  useEffect(() => {
    const prev = document.body.style.cssText;
    document.body.style.background = '#ffffff';
    document.body.style.color = '#1a1a1a';
    return () => { document.body.style.cssText = prev; };
  }, []);

  useEffect(() => {
    const safeFetch = async (url: string) => {
      try { const r = await fetch(url); return r.ok ? await r.json() : null; }
      catch { return null; }
    };
    (async () => {
      const [content, evs, prjs, prms, coop, anal, mark] = await Promise.all([
        safeFetch('/api/public/cms/content'),
        safeFetch('/api/public/cms/events'),
        safeFetch('/api/public/cms/projects'),
        safeFetch('/api/public/cms/promos'),
        safeFetch('/api/public/documents?category=cooperation'),
        safeFetch('/api/public/documents?category=analytics'),
        safeFetch('/api/public/documents?category=marketing'),
      ]);
      if (content) {
        if (content.hero) setHero({ ...DEFAULT_HERO, ...content.hero });
        if (content.advantages) setAdvantages({ ...DEFAULT_ADVANTAGES, ...content.advantages });
        if (content.commission) setCommission({ ...DEFAULT_COMMISSION, ...content.commission });
        if (content.contact) setContact({ ...DEFAULT_CONTACT, ...content.contact });
      }
      if (Array.isArray(evs)) setEvents(evs);
      if (Array.isArray(prjs) && prjs.length) setProjects(prjs);
      if (Array.isArray(prms)) setPromos(prms);
      if (Array.isArray(coop)) setCooperationDocs(coop);
      if (Array.isArray(anal)) setAnalyticsDocs(anal);
      if (Array.isArray(mark)) setMarketingDocs(mark);
    })();
  }, []);

  // Auto-advance promo slider every 6 seconds
  useEffect(() => {
    if (promos.length <= 1) return;
    const id = setInterval(() => setPromoIdx((i) => (i + 1) % promos.length), 6000);
    return () => clearInterval(id);
  }, [promos.length]);

  return (
    <>
      <style dangerouslySetInnerHTML={{__html: `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;500;600;700;800&display=swap');
html{scroll-behavior:smooth}
.lp section{animation:fadeInUp .6s ease both}
@keyframes fadeInUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}
:root{--white:#ffffff;--bg:#f8f7f5;--bg2:#f0eeeb;--bg3:#e8e5e0;--black:#1a1a1a;--dark:#2c2c2a;--dark2:#3d3d3a;--gold:#B4936F;--gold2:#a07e5c;--gold3:#8c6b4a;--gold-bg:rgba(180,147,111,0.07);--gold-border:rgba(180,147,111,0.2);--gold-light:#f5efe8;--muted:#8a8680;--muted2:#a09b95;--light:#6b6660;--bw:rgba(0,0,0,0.08);--bw2:rgba(0,0,0,0.12);--green:#3a8a5c;--r:4px}
body{background:var(--white);color:var(--black);font-family:'Inter',sans-serif;font-size:15px;line-height:1.7;overflow-x:hidden}
.lp a{text-decoration:none;color:inherit}
.lp header{position:sticky;top:0;z-index:200;background:rgba(255,255,255,0.96);backdrop-filter:blur(20px);border-bottom:1px solid var(--bw);display:flex;align-items:center;justify-content:space-between;padding:0 60px;height:68px}
.logo{display:flex;align-items:center;gap:12px}.logo-mark{width:32px;height:32px;background:var(--black);border-radius:4px;display:flex;align-items:center;justify-content:center}.logo-mark span{font-size:10px;font-weight:800;color:var(--white);letter-spacing:1px}.logo-text{font-size:16px;font-weight:700;letter-spacing:2px}.logo-sub{font-size:10px;color:var(--muted);letter-spacing:1px}
.lp nav{display:flex;align-items:center;gap:28px}.lp nav a{color:var(--muted);font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;transition:color .2s}.lp nav a:hover{color:var(--black)}
.h-right{display:flex;align-items:center;gap:16px}.h-phone{font-size:13px;color:var(--muted)}
.btn-enter{display:inline-flex;align-items:center;gap:8px;padding:10px 28px;background:var(--black);color:var(--white);font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;border-radius:50px;transition:all .2s;border:none;cursor:pointer}.btn-enter:hover{background:var(--dark);transform:translateY(-1px);box-shadow:0 4px 16px rgba(0,0,0,0.15)}
.btn-gold{display:inline-flex;align-items:center;gap:8px;padding:14px 32px;background:var(--gold);color:var(--white);font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;border-radius:50px;transition:all .25s;border:none;cursor:pointer}.btn-gold:hover{background:var(--gold2);transform:translateY(-2px);box-shadow:0 8px 24px rgba(180,147,111,0.3)}
.btn-outline{display:inline-flex;align-items:center;gap:8px;padding:14px 32px;background:transparent;color:var(--black);font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;border-radius:50px;border:1px solid var(--bw2);transition:all .2s;cursor:pointer}.btn-outline:hover{border-color:var(--black);background:rgba(0,0,0,0.02)}
.btn-white{display:inline-flex;align-items:center;gap:8px;padding:14px 32px;background:var(--white);color:var(--black);font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;border-radius:50px;transition:all .25s;border:none;cursor:pointer}.btn-white:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,0.15)}
.hero{padding:72px 60px 48px}.hero-inner{max-width:620px;margin-bottom:56px}.hero-tag{display:inline-flex;align-items:center;gap:10px;margin-bottom:24px}.hero-tag::before{content:'';width:28px;height:1px;background:var(--gold)}.hero-tag span{font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:var(--gold)}
.hero h1{font-size:clamp(36px,4.5vw,54px);font-weight:200;line-height:1.1;letter-spacing:-0.5px;margin-bottom:18px}.hero h1 strong{font-weight:800}.hero h1 em{font-style:normal;color:var(--gold)}
.hero-desc{font-size:16px;color:var(--muted);max-width:460px;line-height:1.8;font-weight:300;margin-bottom:32px}.hero-btns{display:flex;gap:12px;flex-wrap:wrap}
.hero-stats{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--bw);border-radius:var(--r);overflow:hidden}.hst{padding:24px 20px;text-align:center;border-right:1px solid var(--bw)}.hst:last-child{border-right:none}.hst-n{font-size:28px;font-weight:700;line-height:1;margin-bottom:5px}.hst-l{font-size:11px;color:var(--muted)}
.quick{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--bw);border-radius:var(--r);overflow:hidden;margin:0 60px}.qa{padding:28px 32px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;transition:background .2s;border-right:1px solid var(--bw)}.qa:last-child{border-right:none}.qa:hover{background:var(--bg)}.qa-title{font-size:15px;font-weight:500}.qa-sub{font-size:12px;color:var(--muted);margin-top:3px}.qa-arrow{width:36px;height:36px;border-radius:50%;border:1px solid var(--bw2);display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:14px;transition:all .2s;flex-shrink:0}.qa:hover .qa-arrow{background:var(--black);color:var(--white);border-color:var(--black)}
.lp section{padding:80px 60px}.sep{border:none;border-top:1px solid var(--bw);margin:0 60px}
.sh{margin-bottom:48px}.sh-center{text-align:center}.sh-tag{font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:var(--gold);margin-bottom:12px}.sh h2{font-size:clamp(28px,3.5vw,42px);font-weight:200;line-height:1.15}.sh h2 strong{font-weight:800}.sh h2 em{font-style:normal;color:var(--gold)}.sh-sub{color:var(--muted);font-size:14px;max-width:500px;margin-top:12px;line-height:1.8;font-weight:300}.sh-center .sh-sub{margin-left:auto;margin-right:auto}
.proj-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}.proj-card{border-radius:var(--r);overflow:hidden;border:1px solid var(--bw);padding:32px 28px;display:flex;flex-direction:column;justify-content:flex-end;min-height:220px;transition:all .3s;cursor:pointer;background:var(--bg)}.proj-card:hover{border-color:var(--gold-border);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,0.06)}.proj-tag{font-size:9px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:var(--gold);margin-bottom:8px}.proj-name{font-size:24px;font-weight:300;margin-bottom:6px}.proj-name strong{font-weight:700}.proj-info{font-size:12px;color:var(--muted);margin-bottom:14px;line-height:1.6}.proj-link{font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--gold);display:inline-flex;align-items:center;gap:6px}
.comm-grid{display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:start}.comm-table{border:1px solid var(--bw);border-radius:var(--r);overflow:hidden}.ct-head{display:grid;grid-template-columns:1fr 1.2fr 0.8fr;padding:12px 20px;background:var(--bg);gap:8px}.ct-head span{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--muted)}.ct-row{display:grid;grid-template-columns:1fr 1.2fr 0.8fr;padding:13px 20px;border-top:1px solid var(--bw);gap:8px;transition:background .15s}.ct-row:hover{background:var(--gold-bg)}.ct-row.active{background:var(--gold-light);border-left:3px solid var(--gold)}.ct-level{font-size:14px;font-weight:500}.ct-row.active .ct-level{color:var(--gold2);font-weight:700}.ct-range{font-size:13px;color:var(--muted)}.ct-rate{font-size:14px;font-weight:600;text-align:right}.ct-row.active .ct-rate{color:var(--gold2)}
.comm-info{display:flex;flex-direction:column;gap:16px}.comm-card{padding:20px 22px;background:var(--bg);border:1px solid var(--bw);border-radius:var(--r)}.comm-card-title{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--gold);margin-bottom:8px}.comm-card p{font-size:13px;color:var(--light);line-height:1.7;font-weight:300}
.s-adv{background:var(--black);color:var(--white);padding:80px 60px}.s-adv .sh-tag{color:var(--gold)}.s-adv h2{color:var(--white)}.s-adv h2 em{color:var(--gold)}.adv-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.08);border-radius:var(--r);overflow:hidden}.adv-card{padding:32px 26px;background:var(--black)}.adv-icon{width:40px;height:40px;border-radius:50%;border:1px solid rgba(255,255,255,0.12);display:flex;align-items:center;justify-content:center;margin-bottom:16px}.adv-title{font-size:15px;font-weight:600;color:var(--white);margin-bottom:8px}.adv-desc{font-size:13px;color:rgba(255,255,255,0.45);line-height:1.7;font-weight:300}
.s-comm{background:var(--gold);padding:80px 60px;position:relative;overflow:hidden}.s-comm .sh-tag{color:rgba(255,255,255,0.6)}.s-comm h2{color:var(--white)}.comm-content{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:28px}.comm-desc{font-size:15px;color:rgba(255,255,255,0.8);line-height:1.8;font-weight:300;margin-bottom:24px}.comm-list{display:flex;flex-direction:column;gap:10px}.comm-list-item{display:flex;align-items:flex-start;gap:10px;font-size:14px;color:rgba(255,255,255,0.9)}.comm-list-dot{width:6px;height:6px;border-radius:50%;background:var(--white);flex-shrink:0;margin-top:7px}
.s-cta{text-align:center;padding:100px 60px}
.lp footer{padding:40px 60px;border-top:1px solid var(--bw);background:var(--bg)}.foot-grid{display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;gap:40px;margin-bottom:28px}.foot-logo{font-size:14px;font-weight:700;letter-spacing:2.5px;margin-bottom:2px}.foot-logo-sub{font-size:10px;color:var(--muted);letter-spacing:1px}.foot-col-title{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--gold);margin-bottom:12px}.foot-link{display:block;font-size:13px;color:var(--muted);margin-bottom:7px;transition:color .2s}.foot-link:hover{color:var(--black)}.foot-bottom{display:flex;justify-content:space-between;align-items:center;padding-top:18px;border-top:1px solid var(--bw);font-size:12px;color:var(--muted2)}
.float-btn{position:fixed;bottom:28px;right:28px;z-index:100;padding:14px 28px;background:var(--black);color:var(--white);font-size:12px;font-weight:700;letter-spacing:1px;border-radius:50px;cursor:pointer;border:none;box-shadow:0 4px 20px rgba(0,0,0,0.2);transition:all .25s}.float-btn:hover{transform:translateY(-2px);box-shadow:0 8px 32px rgba(0,0,0,0.3)}
.ev-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.ev-card{padding:22px 24px;border:1px solid var(--bw);border-radius:var(--r);display:flex;align-items:center;gap:18px;cursor:pointer;transition:all .2s;background:var(--white)}.ev-card:hover{border-color:var(--gold-border);background:var(--gold-bg)}.ev-date{width:50px;height:50px;border-radius:var(--r);background:var(--bg);border:1px solid var(--bw);display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0}.ev-day{font-size:20px;font-weight:700;line-height:1}.ev-mon{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px}.ev-info{flex:1}.ev-title{font-size:14px;font-weight:500;margin-bottom:2px}.ev-meta{font-size:12px;color:var(--muted)}
.coop-grid{display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:start}.coop-left p{font-size:15px;color:var(--muted);line-height:1.8;font-weight:300;margin-bottom:24px}.doc-list{display:flex;flex-direction:column;gap:6px}.doc-item{display:flex;align-items:center;gap:12px;padding:14px 18px;background:var(--white);border:1px solid var(--bw);border-radius:var(--r);cursor:pointer;transition:all .2s}.doc-item:hover{border-color:var(--gold-border);background:var(--gold-bg)}.doc-name{font-size:13px;flex:1}.doc-dl{color:var(--muted);font-size:14px}
@media(max-width:960px){.lp header{padding:0 20px}.lp nav{display:none}.lp section,.hero,.s-adv,.s-comm,.s-cta,.lp footer{padding-left:20px;padding-right:20px}.quick,.sep{margin-left:20px;margin-right:20px}.hero-stats{grid-template-columns:repeat(2,1fr)}.quick,.proj-grid,.ev-grid,.comm-content,.coop-grid,.comm-grid,.adv-grid{grid-template-columns:1fr}.foot-grid{grid-template-columns:1fr 1fr}}
      `}} />

      <div className="lp">
        <header>
          <a className="logo" href="#">
            <div className="logo-mark"><span>SM</span></div>
            <div><div className="logo-text">ST MICHAEL</div><div className="logo-sub">Кабинет брокера</div></div>
          </a>
          <nav>
            <a href="#projects">Проекты</a>
            <a href="#commission">Комиссия</a>
            <a href="#events">Мероприятия</a>
            <a href="#cooperation">Документы</a>
            <a href="#materials">Материалы</a>
            <a href="#contact">Контакты</a>
          </nav>
          <div className="h-right">
            <a className="h-phone" href="tel:+74992262249">+7 (499) 226-22-49</a>
            <button className="btn-enter" onClick={handleCabinet}>{broker ? 'КАБИНЕТ' : 'ВОЙТИ'}</button>
          </div>
        </header>

        {/* HERO */}
        <div className="hero">
          <div className="hero-inner">
            <div className="hero-tag"><span>{hero.tag}</span></div>
            <h1><strong>{renderAccent(hero.title, hero.titleAccent)}</strong></h1>
            <p className="hero-desc" style={{marginBottom:32}}>{hero.description}</p>
          </div>
          <div className="hero-stats">
            {(hero.stats || []).map((s: any, i: number) => (
              <div key={i} className="hst"><div className="hst-n">{s.number}</div><div className="hst-l">{s.label}</div></div>
            ))}
          </div>
        </div>

        {/* PROJECTS */}
        <section id="projects">
          <div className="sh"><div className="sh-tag">Проекты</div><h2>Проекты — <em>одна программа</em></h2><p className="sh-sub">Квадратные метры суммируются по всем проектам для роста вашей ставки комиссии</p></div>
          <div className="proj-grid">
            {projects.map((p: any) => (
              <div key={p.id} className="proj-card" onClick={() => handleProjectClick(p)} style={p.imageUrl ? { backgroundImage: `linear-gradient(rgba(248,247,245,0.94), rgba(248,247,245,0.94)), url(${p.imageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center', minHeight: 280 } : undefined}>
                {p.tag && <div className="proj-tag">{p.tag}</div>}
                <div className="proj-name"><strong>{p.name}</strong>{p.subtitle ? ` ${p.subtitle}` : ''}</div>
                <div className="proj-info">{p.description}</div>

                {(p.classType || p.address || p.readyYear || p.totalUnits || p.commissionFrom) && (
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'6px 16px',fontSize:11,color:'var(--muted)',marginTop:8,marginBottom:12}}>
                    {p.classType && <div><span style={{color:'var(--muted2)'}}>Класс:</span> <strong style={{color:'var(--black)'}}>{p.classType}</strong></div>}
                    {p.address && <div><span style={{color:'var(--muted2)'}}>Адрес:</span> <strong style={{color:'var(--black)'}}>{p.address}</strong></div>}
                    {p.readyYear && <div><span style={{color:'var(--muted2)'}}>Сдача:</span> <strong style={{color:'var(--black)'}}>{p.readyQuarter ? `${p.readyQuarter} кв. ` : ''}{p.readyYear}</strong></div>}
                    {p.floorsTotal && <div><span style={{color:'var(--muted2)'}}>Этажей:</span> <strong style={{color:'var(--black)'}}>{p.floorsTotal}</strong></div>}
                    {p.totalUnits && <div><span style={{color:'var(--muted2)'}}>Лотов:</span> <strong style={{color:'var(--black)'}}>{p.totalUnits}</strong></div>}
                    {(p.commissionFrom || p.commissionTo) && <div><span style={{color:'var(--muted2)'}}>Комиссия:</span> <strong style={{color:'var(--gold)'}}>{p.commissionFrom}{p.commissionTo && p.commissionTo !== p.commissionFrom ? `–${p.commissionTo}` : ''}%</strong></div>}
                  </div>
                )}

                <div className="proj-link">{p.ctaText || 'Смотреть каталог'} &rarr;</div>
              </div>
            ))}
          </div>
        </section>

        {/* PROMO SLIDER (block 3) */}
        {promos.length > 0 && (
          <section id="promos" style={{padding:'40px 60px'}}>
            <div style={{position:'relative',background:'var(--bg)',border:'1px solid var(--bw)',borderRadius:'var(--r)',overflow:'hidden',minHeight:200}}>
              {promos.map((p, i) => (
                <div key={p.id} style={{
                  display: i === promoIdx ? 'flex' : 'none',
                  flexDirection: 'row',
                  alignItems: 'center',
                  padding: '32px 40px',
                  gap: 32,
                  minHeight: 200,
                  ...(p.imageUrl ? { backgroundImage: `linear-gradient(rgba(255,255,255,0.85), rgba(255,255,255,0.85)), url(${p.imageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' } : {}),
                }}>
                  <div style={{flex:1}}>
                    {p.tag && <div style={{fontSize:10,fontWeight:700,letterSpacing:3,textTransform:'uppercase',color:'var(--gold)',marginBottom:10}}>{p.tag}</div>}
                    <h3 style={{fontSize:'clamp(20px,2.5vw,30px)',fontWeight:300,marginBottom:8,color:'var(--black)'}}>
                      <strong>{p.title}</strong>
                    </h3>
                    {p.subtitle && <div style={{fontSize:15,color:'var(--muted)',marginBottom:8}}>{p.subtitle}</div>}
                    {p.description && <div style={{fontSize:14,color:'var(--light)',lineHeight:1.7,marginBottom:16,maxWidth:600}}>{p.description}</div>}
                    {(p.ctaText || p.ctaHref) && (
                      <a href={p.ctaHref || '#projects'} className="btn-gold" target={p.ctaHref?.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer">
                        {p.ctaText || 'Подробнее'}
                      </a>
                    )}
                  </div>
                </div>
              ))}
              {promos.length > 1 && (
                <div style={{position:'absolute',bottom:14,left:0,right:0,display:'flex',justifyContent:'center',gap:6}}>
                  {promos.map((_, i) => (
                    <button key={i} onClick={() => setPromoIdx(i)} style={{
                      width: i === promoIdx ? 24 : 8, height: 8, borderRadius: 4,
                      background: i === promoIdx ? 'var(--gold)' : 'rgba(0,0,0,0.2)',
                      border: 'none', cursor: 'pointer', transition: 'all .25s',
                    }} aria-label={`Слайд ${i+1}`} />
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        <hr className="sep" />

        {/* COMMISSION */}
        <section id="commission">
          <div className="sh"><div className="sh-tag">{commission.tag}</div><h2>{renderAccent(commission.title, commission.titleAccent)}</h2>{commission.subtitle && <p className="sh-sub">{commission.subtitle}</p>}</div>

          {commission.levelsByProject && (
            <div style={{display:'flex',justifyContent:'center',gap:8,marginBottom:24}}>
              {(['ZORGE9', 'SILVER_BOR'] as const).map((proj) => (
                <button
                  key={proj}
                  onClick={() => setCommissionProject(proj)}
                  style={{
                    padding: '10px 24px',
                    background: commissionProject === proj ? 'var(--gold)' : 'var(--bg)',
                    color: commissionProject === proj ? 'var(--white)' : 'var(--muted)',
                    border: '1px solid ' + (commissionProject === proj ? 'var(--gold)' : 'var(--bw)'),
                    borderRadius: 50,
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: 1.5,
                    textTransform: 'uppercase',
                    cursor: 'pointer',
                    transition: 'all .2s',
                  }}
                >
                  {proj === 'ZORGE9' ? 'Зорге 9' : 'Серебряный Бор'}
                </button>
              ))}
            </div>
          )}

          <div className="comm-grid">
            <div>
              <div className="comm-table">
                <div className="ct-head"><span>Уровень</span><span>Объём м2/кв.</span><span>Ставка</span></div>
                {((commission.levelsByProject?.[commissionProject]) || commission.levels || []).map((lv: any, i: number) => (
                  <div key={i} className={`ct-row${lv.active ? ' active' : ''}`}>
                    <span className="ct-level">{lv.name}</span>
                    <span className="ct-range">{lv.range}</span>
                    <span className="ct-rate">{lv.rate}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="comm-info">
              {(commission.cards || []).map((c: any, i: number) => (
                <div key={i} className="comm-card">
                  <div className="comm-card-title">{c.title}</div>
                  <p>{c.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <hr className="sep" />

        {/* EVENTS */}
        <section id="events" style={{background:'var(--bg)'}}>
          <div className="sh"><div className="sh-tag">Календарь событий</div><h2>Ближайшие <em>мероприятия</em></h2></div>
          {events.length === 0 ? (
            <div style={{textAlign:'center',color:'var(--muted)',fontSize:14,padding:'24px 0'}}>В ближайшее время мероприятий не запланировано</div>
          ) : (
            <div className="ev-grid">
              {events.map((ev: any) => {
                const d = formatEventDate(ev.date);
                const eventDate = new Date(ev.date).toLocaleString('ru-RU', { day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
                return (
                  <div
                    key={ev.id}
                    className="ev-card"
                    onClick={() => setContactModal({
                      open: true,
                      source: 'event-signup',
                      eventId: ev.id,
                      title: `Запись: ${ev.title}`,
                      defaultMessage: `Хочу записаться на «${ev.title}» — ${eventDate}`,
                    })}
                  >
                    <div className="ev-date"><div className="ev-day">{d.day}</div><div className="ev-mon">{d.mon}</div></div>
                    <div className="ev-info">
                      <div className="ev-title">{ev.title}</div>
                      <div className="ev-meta">{formatEventMeta(ev.date, ev.location, ev.isOnline)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <hr className="sep" />

        {/* HOW TO START — 4 шага старта */}
        <section id="how-to-start">
          <div className="sh sh-center"><div className="sh-tag">Старт</div><h2>Как начать сотрудничать с <em>ST Michael</em></h2><p className="sh-sub">Можно начать сотрудничество с первой сделки — даже с первого дня существования вашего ИП. Без дополнительных условий.</p></div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(4, 1fr)',gap:16,maxWidth:1100,margin:'0 auto'}}>
            {[
              { n: '01', title: 'ИП или ООО', desc: 'Достаточно зарегистрированного юр. лица — ИП, ООО, АО.' },
              { n: '02', title: 'Регистрация в кабинете', desc: 'Заполните анкету за 2 минуты — становитесь партнёром сразу.' },
              { n: '03', title: 'Проверка клиента', desc: 'Зафиксируйте клиента в кабинете и получите статус уникальности.' },
              { n: '04', title: 'Запись на встречу', desc: 'Запишите клиента на встречу — горячая линия +7 (499) 226-22-49.' },
            ].map((s, i) => (
              <div key={i} style={{padding:'24px 22px',background:'var(--bg)',border:'1px solid var(--bw)',borderRadius:'var(--r)'}}>
                <div style={{fontSize:32,fontWeight:200,color:'var(--gold)',marginBottom:12,lineHeight:1}}>{s.n}</div>
                <div style={{fontSize:15,fontWeight:600,marginBottom:6,color:'var(--black)'}}>{s.title}</div>
                <div style={{fontSize:13,color:'var(--muted)',lineHeight:1.6}}>{s.desc}</div>
              </div>
            ))}
          </div>
          <p style={{textAlign:'center',fontSize:13,color:'var(--muted)',marginTop:20,maxWidth:700,marginLeft:'auto',marginRight:'auto',lineHeight:1.7}}>
            Агентский договор заключается под конкретную сделку. Полные условия партнёрства — в кабинете брокера.
          </p>
          <div style={{textAlign:'center',marginTop:24}}>
            <button className="btn-gold" onClick={handleRegister}>Стать партнёром</button>
          </div>
        </section>

        {/* ADVANTAGES */}
        <section className="s-adv">
          <div className="sh"><div className="sh-tag">{advantages.tag}</div><h2>{renderAccent(advantages.title, advantages.titleAccent)}</h2></div>
          <div className="adv-grid">
            {(advantages.items || []).map((it: any, i: number) => (
              <div key={i} className="adv-card">
                <div className="adv-title">{it.title}</div>
                <div className="adv-desc">{it.description}</div>
              </div>
            ))}
          </div>
        </section>

        <hr className="sep" />

        {/* DOCUMENTS — Все прозрачно */}
        <section id="cooperation">
          <div className="sh"><div className="sh-tag">Условия сотрудничества</div><h2>Всё прозрачно — <em>документы</em></h2><p className="sh-sub">Брокер может заранее ознакомиться с условиями партнёрства до регистрации</p></div>
          <div className="coop-grid">
            <div className="coop-left">
              <p>Мы рассматриваем сотрудничество с позиции «выиграл-выиграл». Все условия зафиксированы в документах и доступны в личном кабинете.</p>
              <button className="btn-gold" onClick={handleRegister}>Стать партнёром</button>
            </div>
            <div className="doc-list">
              {cooperationDocs.length === 0 ? (
                <div className="doc-item" style={{cursor:'default'}}><div className="doc-name" style={{color:'var(--muted)'}}>Скоро здесь появятся документы</div></div>
              ) : (
                cooperationDocs.map((d: any) => (
                  <a key={d.id} href={d.fileUrl} target="_blank" rel="noopener noreferrer" className="doc-item">
                    <div className="doc-name">{d.name}</div>
                    <div className="doc-dl">&darr;</div>
                  </a>
                ))
              )}
            </div>
          </div>
        </section>

        <hr className="sep" />

        {/* ANALYTICS — Аналитика */}
        <section id="analytics" style={{background:'var(--bg)'}}>
          <div className="sh"><div className="sh-tag">Аналитика</div><h2>Инструменты <em>инвестирования</em></h2><p className="sh-sub">Калькуляторы, презентации и аналитика для работы с клиентами-инвесторами</p></div>
          <div className="ads-grid" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            {analyticsDocs.length === 0 ? (
              <div className="doc-item" style={{cursor:'default',gridColumn:'span 2'}}><div className="doc-name" style={{color:'var(--muted)'}}>Скоро здесь появятся материалы</div></div>
            ) : (
              analyticsDocs.map((d: any) => (
                <a key={d.id} href={d.fileUrl} target="_blank" rel="noopener noreferrer" className="doc-item">
                  <div className="doc-name">{d.name}</div>
                  <div className="doc-dl">&rarr;</div>
                </a>
              ))
            )}
          </div>
        </section>

        <hr className="sep" />

        {/* MARKETING — Материалы для продвижения */}
        <section id="materials">
          <div className="sh"><div className="sh-tag">Реклама</div><h2>Материалы для <em>продвижения</em></h2><p className="sh-sub">Готовые материалы для работы с клиентами. Часть доступна только в личном кабинете.</p></div>
          <div className="ads-grid" style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12}}>
            {marketingDocs.length === 0 ? (
              <div className="doc-item" style={{cursor:'default',gridColumn:'span 3'}}><div className="doc-name" style={{color:'var(--muted)'}}>Скоро здесь появятся материалы</div></div>
            ) : (
              marketingDocs.map((d: any) => (
                <a key={d.id} href={d.fileUrl} target="_blank" rel="noopener noreferrer" className="doc-item">
                  <div className="doc-name">{d.name}</div>
                  <div className="doc-dl">&rarr;</div>
                </a>
              ))
            )}
          </div>
        </section>

        <hr className="sep" />

        {/* FAQ — Часто задаваемые вопросы */}
        <section id="faq" style={{background:'var(--bg)'}}>
          <div className="sh sh-center"><div className="sh-tag">Вопросы</div><h2>Часто задаваемые <em>вопросы</em></h2></div>
          <div style={{maxWidth:820,margin:'0 auto'}}>
            {[
              {
                q: 'Как стать партнёром?',
                a: 'Начать работу можно без заключения общего агентского договора. Достаточно зарегистрироваться в кабинете брокера, проверить клиента на уникальность и записать его на встречу. Агентский договор заключается под конкретную сделку. Для сотрудничества нужно зарегистрированное юр. лицо (ИП, ООО, АО).',
              },
              {
                q: 'Как проверить клиента на уникальность?',
                a: 'В личном кабинете во вкладке «Зафиксировать клиента» заполните данные и нажмите «Отправить». Получите статус «Условно уникален» (можно работать) или «Отклонён» (клиент уже в базе). Для дополнительных номеров (ЛПР, супруг, родители) используйте функцию «Дополнительные номера».',
              },
              {
                q: 'Что делать, если статус «Отклонён»?',
                a: 'Это значит клиент уже зарегистрирован другим брокером или обращался самостоятельно. Статус может быть изменён на «Условно уникален» после ручной проверки. Мы можем запросить подтверждение взаимодействия с клиентом (переписка, записи звонков, посещения офиса). Уведомление о решении придёт в WhatsApp / Telegram.',
              },
              {
                q: 'Какой срок действия фиксации?',
                a: 'Фиксация проходит в два этапа: до встречи с клиентом — 30 календарных дней, после встречи до сделки — ещё 30 дней. В обоих случаях возможна пролонгация по запросу через горячую линию +7 (499) 226-22-49. Брокер сам отслеживает сроки фиксации.',
              },
              {
                q: 'Как записать клиента на встречу?',
                a: 'Через горячую линию для брокеров: +7 (499) 226-22-49 (ежедневно с 9:00 до 21:00). Менеджер подберёт удобное время и проконсультирует по проектам. Клиент закрепляется за брокером после посещения офиса (или онлайн-встречи) и подписания акта осмотра.',
              },
              {
                q: 'Как происходит выплата комиссии?',
                a: 'Выплата производится после завершения сделки и полной оплаты со стороны клиента — в течение 7 рабочих дней. После сделки направьте информацию менеджеру — отправим инструкцию по получению выплаты.',
              },
            ].map((item, i) => (
              <FaqItem key={i} q={item.q} a={item.a} />
            ))}
          </div>
        </section>

        {/* COMMUNITY — Партнёрская программа */}
        <section className="s-comm">
          <div><div className="sh-tag">Партнёрская программа</div><h2><strong>ST MICHAEL</strong> Партнёры</h2></div>
          <div className="comm-content">
            <div>
              <p className="comm-desc">Сообщество, объединяющее активных профессионалов рынка недвижимости. Приоритетные условия и доступ к закрытым мероприятиям.</p>
              <button className="btn-white" onClick={handleRegister}>Стать частью сообщества</button>
            </div>
            <div className="comm-list">
              <div className="comm-list-item"><div className="comm-list-dot" />Специальные гибкие условия для участников</div>
              <div className="comm-list-item"><div className="comm-list-dot" />Приоритетное информирование о стартах продаж</div>
              <div className="comm-list-item"><div className="comm-list-dot" />Образовательные встречи и мастер-классы</div>
              <div className="comm-list-item"><div className="comm-list-dot" />Тематические мероприятия и нетворкинг</div>
              <div className="comm-list-item"><div className="comm-list-dot" />Самые свежие новости и события компании</div>
            </div>
          </div>
        </section>

        <hr className="sep" />

        {/* CONTACT — Всегда на связи */}
        <section id="contact">
          <div className="sh"><div className="sh-tag">{contact.tag}</div><h2>{renderAccent(contact.title, contact.titleAccent)}</h2></div>
          <div className="coop-grid">
            <div className="coop-left">
              <p>{contact.description}</p>
              <div style={{padding:'16px 18px',background:'var(--bg)',borderRadius:'var(--r)',border:'1px solid var(--bw)',marginBottom:12}}>
                <div style={{fontSize:11,fontWeight:700,letterSpacing:2,textTransform:'uppercase',color:'var(--gold)',marginBottom:8}}>{contact.blockTitle}</div>
                {contact.phone && <div style={{fontSize:16,marginBottom:4}}><a href={`tel:${contact.phone.replace(/\D/g,'')}`} style={{color:'var(--black)',fontWeight:700}}>{contact.phone}</a></div>}
                {contact.phoneHours && <div style={{fontSize:12,color:'var(--muted)',marginBottom:6}}>{contact.phoneHours}</div>}
                {contact.email && <div style={{fontSize:14,marginBottom:4}}><a href={`mailto:${contact.email}`} style={{color:'var(--black)'}}>{contact.email}</a></div>}
                {contact.telegram && <div style={{fontSize:14}}><a href={contact.telegram} target="_blank" rel="noopener noreferrer" style={{color:'var(--gold)'}}>Telegram</a></div>}
              </div>
              {contact.manager && (
                <div style={{padding:'14px 18px',background:'var(--white)',borderRadius:'var(--r)',border:'1px solid var(--gold-border)'}}>
                  <div style={{fontSize:10,fontWeight:700,letterSpacing:2,textTransform:'uppercase',color:'var(--muted)',marginBottom:6}}>Персональный контакт</div>
                  <div style={{fontSize:15,fontWeight:600,color:'var(--black)',marginBottom:2}}>{contact.manager.name}</div>
                  {contact.manager.role && <div style={{fontSize:12,color:'var(--muted)',marginBottom:6}}>{contact.manager.role}</div>}
                  {contact.manager.phone && <div style={{fontSize:14}}><a href={`tel:${contact.manager.phone.replace(/\D/g,'')}`} style={{color:'var(--black)',fontWeight:600}}>{contact.manager.phone}</a></div>}
                </div>
              )}
            </div>
            <div style={{padding:'24px 28px',background:'var(--bg)',borderRadius:'var(--r)',border:'1px solid var(--bw)'}}>
              <div style={{fontSize:11,fontWeight:700,letterSpacing:2,textTransform:'uppercase',color:'var(--gold)',marginBottom:14}}>Связаться с менеджером</div>
              <p style={{fontSize:13,color:'var(--muted)',marginBottom:14,lineHeight:1.7}}>Оставьте заявку — наш менеджер партнёрской программы свяжется с вами в течение часа.</p>
              <button className="btn-gold" onClick={() => setContactModal({ open: true, source: 'landing-contact', title: 'Связаться с нами' })}>
                Оставить заявку
              </button>
            </div>
          </div>
        </section>

        <hr className="sep" />

        {/* FINAL CTA */}
        <section className="s-cta">
          <div className="sh sh-center" style={{marginBottom:0}}><div className="sh-tag">Начните сегодня</div><h2>Присоединяйтесь к <em>партнёрской программе</em></h2><p className="sh-sub">Регистрация за 2 минуты. Личный кабинет, прозрачные условия, быстрые выплаты.</p></div>
          <div style={{display:'flex',justifyContent:'center',gap:12,flexWrap:'wrap',marginTop:36}}>
            <button className="btn-gold" onClick={handleRegister}>Стать партнёром</button>
            <button className="btn-outline" onClick={handleCabinet}>Войти в кабинет</button>
            <a href="https://t.me/stmichaelBroker" target="_blank" rel="noopener noreferrer" className="btn-outline">Telegram-канал</a>
          </div>
        </section>

        {/* FOOTER */}
        <footer>
          <div className="foot-grid">
            <div><div className="foot-logo">ST MICHAEL</div><div className="foot-logo-sub">Кабинет брокера</div></div>
            <div><div className="foot-col-title">Условия</div><a className="foot-link" href="#cooperation">Условия сотрудничества</a><a className="foot-link" href="#events">Календарь событий</a><a className="foot-link" href="#commission">Комиссия</a></div>
            <div><div className="foot-col-title">Проекты</div>{projects.map((p: any) => (<span key={p.id} className="foot-link" onClick={() => handleProjectClick(p)} style={{cursor:'pointer'}}>{p.name}{p.subtitle ? ` ${p.subtitle}` : ''}</span>))}</div>
            <div><div className="foot-col-title">Партнёрам</div>{contact.phone && <a className="foot-link" href={`tel:${contact.phone.replace(/\D/g,'')}`}>{contact.phone}</a>}{contact.email && <a className="foot-link" href={`mailto:${contact.email}`}>{contact.email}</a>}{contact.telegram && <a className="foot-link" href={contact.telegram}>Telegram</a>}</div>
          </div>
          <div className="foot-bottom"><span>&copy; 2026 ST MICHAEL. Все права защищены.</span><span>Данные носят ориентировочный характер.</span></div>
        </footer>

        <button className="float-btn" onClick={()=>window.open('https://wa.me/74992262249','_blank')}>Связаться с нами</button>
      </div>

      {authModal && (
        <AuthModal
          mode={authModal}
          onClose={() => setAuthModal(null)}
          onSwitch={() => setAuthModal(authModal === 'login' ? 'register' : 'login')}
          onSuccess={() => { setAuthModal(null); router.push('/fixation'); }}
        />
      )}

      {quickFixOpen && <QuickFixModal onClose={() => setQuickFixOpen(false)} />}

      {contactModal.open && (
        <ContactFormModal
          onClose={() => setContactModal({ open: false })}
          source={contactModal.source}
          eventId={contactModal.eventId}
          title={contactModal.title}
          defaultMessage={contactModal.defaultMessage}
        />
      )}
    </>
  );
}
