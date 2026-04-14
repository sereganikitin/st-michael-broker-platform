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
  const [fullName, setFullName] = useState('');
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

  const doLogin = async (p: string, pw: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: p, password: pw }),
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
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: fullPhone, fullName,
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
              <input placeholder="ФИО" value={fullName} onChange={e=>setFullName(e.target.value)}
                style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            )}
            <PhoneInput value={phoneDigits} onChange={setPhoneDigits} />
            {mode === 'register' && (
              <input placeholder="Email (необязательно)" type="email" value={email} onChange={e=>setEmail(e.target.value)}
                style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            )}
            {mode === 'register' && (
              <input placeholder="Название агентства" value={agencyName} onChange={e=>setAgencyName(e.target.value)}
                style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            )}
            {mode === 'register' && (
              <input placeholder="ИНН (10 или 12 цифр)" inputMode="numeric" value={inn}
                onChange={e=>setInn(e.target.value.replace(/\D/g,'').slice(0,12))}
                style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            )}
            {mode === 'register' && (
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
            )}
            <input placeholder="Пароль" type="password" value={password} onChange={e=>setPassword(e.target.value)}
              onKeyDown={e=>e.key==='Enter' && (mode==='login' ? handleLogin() : handleRegister())}
              style={{padding:'12px 16px',border:'1px solid rgba(0,0,0,0.12)',borderRadius:4,fontSize:14,outline:'none'}} />
            <button onClick={mode==='login' ? handleLogin : handleRegister}
              disabled={loading || phoneDigits.length !== 10 || !password || (mode==='register' && !fullName)}
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

export default function LandingPage() {
  const [authModal, setAuthModal] = useState<'login' | 'register' | null>(null);
  const { broker } = useAuth();
  const router = useRouter();

  const handleCabinet = () => { if (broker) router.push('/fixation'); else setAuthModal('login'); };
  const handleRegister = () => { if (broker) router.push('/fixation'); else setAuthModal('register'); };

  useEffect(() => {
    const prev = document.body.style.cssText;
    document.body.style.background = '#ffffff';
    document.body.style.color = '#1a1a1a';
    return () => { document.body.style.cssText = prev; };
  }, []);

  return (
    <>
      <style dangerouslySetInnerHTML={{__html: `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;500;600;700;800&display=swap');
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
            <a href="#events">События</a>
            <a href="#cooperation">Условия</a>
          </nav>
          <div className="h-right">
            <a className="h-phone" href="tel:+74951504010">+7 (495) 150-40-10</a>
            <button className="btn-enter" onClick={handleCabinet}>{broker ? 'КАБИНЕТ' : 'ВОЙТИ'}</button>
          </div>
        </header>

        {/* HERO */}
        <div className="hero">
          <div className="hero-inner">
            <div className="hero-tag"><span>Партнёрская программа</span></div>
            <h1>Зарабатывайте<br /><strong>до <em>8% комиссии</em></strong></h1>
            <p className="hero-desc">Продавайте апартаменты Зорге 9 и Квартал Серебряный Бор. Прогрессивная шкала, личный кабинет, выделенная поддержка на каждом этапе сделки.</p>
            <div className="hero-btns">
              <button className="btn-gold" onClick={handleRegister}>Стать партнёром</button>
              <a href="#commission" className="btn-outline">Условия комиссии</a>
            </div>
          </div>
          <div className="hero-stats">
            <div className="hst"><div className="hst-n">5-8%</div><div className="hst-l">Комиссия от стоимости</div></div>
            <div className="hst"><div className="hst-n">5 дней</div><div className="hst-l">Выплата после оплаты</div></div>
            <div className="hst"><div className="hst-n">30 дней</div><div className="hst-l">Фиксация клиента</div></div>
            <div className="hst"><div className="hst-n">2</div><div className="hst-l">Проекта в портфеле</div></div>
          </div>
        </div>

        {/* QUICK ACTIONS */}
        <div className="quick">
          <div className="qa" onClick={handleCabinet}><div><div className="qa-title">Записаться на встречу с клиентом</div><div className="qa-sub">+7 (495) 150-40-10</div></div><div className="qa-arrow">&rarr;</div></div>
          <a className="qa" href="#events"><div><div className="qa-title">Записаться на брокер-тур</div><div className="qa-sub">Ближайший — 28 марта</div></div><div className="qa-arrow">&rarr;</div></a>
          <div className="qa" onClick={handleRegister}><div><div className="qa-title">Стать партнёром ST MICHAEL</div><div className="qa-sub">Регистрация за 2 минуты</div></div><div className="qa-arrow">&rarr;</div></div>
        </div>

        <div style={{height:60}} />

        {/* PROJECTS */}
        <section id="projects">
          <div className="sh"><div className="sh-tag">Проекты</div><h2>Два проекта — <em>одна программа</em></h2><p className="sh-sub">Квадратные метры суммируются по обоим проектам для роста вашей ставки комиссии</p></div>
          <div className="proj-grid">
            <div className="proj-card" onClick={handleCabinet}><div className="proj-tag">Приоритетный проект</div><div className="proj-name"><strong>Зорге</strong> 9</div><div className="proj-info">Апартаменты бизнес-класса у метро Полежаевская. 3 корпуса, архитектура в стиле Арт-Москва. От 270 000 р/м2.</div><div className="proj-link">Смотреть каталог &rarr;</div></div>
            <div className="proj-card" onClick={handleCabinet}><div className="proj-tag">Новый проект</div><div className="proj-name"><strong>Квартал</strong> Серебряный Бор</div><div className="proj-info">Жилой комплекс премиум-класса рядом с Серебряным Бором. Уникальная локация и инфраструктура.</div><div className="proj-link">Смотреть каталог &rarr;</div></div>
          </div>
        </section>

        <hr className="sep" />

        {/* COMMISSION */}
        <section id="commission">
          <div className="sh"><div className="sh-tag">Комиссия и условия выплаты</div><h2>Прогрессивная <em>шкала</em> вознаграждения</h2><p className="sh-sub">Чем больше продаёте — тем выше ставка. Накопление по агентству, по обоим проектам.</p></div>
          <div className="comm-grid">
            <div>
              <div className="comm-table">
                <div className="ct-head"><span>Уровень</span><span>Объём м2/кв.</span><span>Ставка</span></div>
                <div className="ct-row"><span className="ct-level">Start</span><span className="ct-range">0-59 м2</span><span className="ct-rate">5,0%</span></div>
                <div className="ct-row"><span className="ct-level">Basic</span><span className="ct-range">60-119 м2</span><span className="ct-rate">5,5%</span></div>
                <div className="ct-row active"><span className="ct-level">Strong</span><span className="ct-range">120-199 м2</span><span className="ct-rate">6,0%</span></div>
                <div className="ct-row"><span className="ct-level">Premium</span><span className="ct-range">200-319 м2</span><span className="ct-rate">6,5%</span></div>
                <div className="ct-row"><span className="ct-level">Elite</span><span className="ct-range">320-499 м2</span><span className="ct-rate">7,0%</span></div>
                <div className="ct-row"><span className="ct-level">Champion</span><span className="ct-range">500-699 м2</span><span className="ct-rate">7,5%</span></div>
                <div className="ct-row"><span className="ct-level">Legend</span><span className="ct-range">700+ м2</span><span className="ct-rate">8,0%</span></div>
              </div>
            </div>
            <div className="comm-info">
              <div className="comm-card"><div className="comm-card-title">Условия выплаты</div><p>Выплата в течение 5 рабочих дней с момента оплаты клиентом не менее 50% (Зорге 9) или 30% (Серебряный Бор) от суммы договора.</p></div>
              <div className="comm-card"><div className="comm-card-title">Квартальный бонус</div><p>При уровне Strong и выше несколько кварталов подряд: +0,1% — +0,15% — +0,2% — +0,25% (максимум).</p></div>
              <div className="comm-card"><div className="comm-card-title">Рассрочка и ипотека</div><p>При рассрочке ставка уменьшается на 0,5%. При субсидированной ипотеке — фиксированные 4%.</p></div>
              <div className="comm-card"><div className="comm-card-title">Коммерческие помещения</div><p>Продажа — 3%. Фитнес — 3%. Отдельные здания — 2%. Аренда ритейл — 100% месячного платежа.</p></div>
            </div>
          </div>
        </section>

        <hr className="sep" />

        {/* EVENTS */}
        <section id="events" style={{background:'var(--bg)'}}>
          <div className="sh"><div className="sh-tag">Календарь событий</div><h2>Ближайшие <em>мероприятия</em></h2></div>
          <div className="ev-grid">
            <div className="ev-card"><div className="ev-date"><div className="ev-day">28</div><div className="ev-mon">мар</div></div><div className="ev-info"><div className="ev-title">Брокер-тур: Зорге 9</div><div className="ev-meta">28 марта, пт, 11:00</div></div></div>
            <div className="ev-card"><div className="ev-date"><div className="ev-day">02</div><div className="ev-mon">апр</div></div><div className="ev-info"><div className="ev-title">Вебинар: Инвест-стратегии в апартаментах</div><div className="ev-meta">2 апреля, ср, 14:00. Онлайн</div></div></div>
            <div className="ev-card"><div className="ev-date"><div className="ev-day">10</div><div className="ev-mon">апр</div></div><div className="ev-info"><div className="ev-title">Брокер-тур: Серебряный Бор</div><div className="ev-meta">10 апреля, чт, 11:00</div></div></div>
            <div className="ev-card"><div className="ev-date"><div className="ev-day">15</div><div className="ev-mon">апр</div></div><div className="ev-info"><div className="ev-title">Обучение: как продавать апартаменты</div><div className="ev-meta">15 апреля, вт, 16:00. Офис ST MICHAEL</div></div></div>
          </div>
        </section>

        {/* ADVANTAGES */}
        <section className="s-adv">
          <div className="sh"><div className="sh-tag">Преимущества</div><h2>Почему брокеры <em>выбирают нас</em></h2></div>
          <div className="adv-grid">
            <div className="adv-card"><div className="adv-title">Выделенный отдел партнёров</div><div className="adv-desc">Команда всегда на связи для решения любых вопросов по сделкам и клиентам.</div></div>
            <div className="adv-card"><div className="adv-title">30 дней фиксации клиента</div><div className="adv-desc">Один из самых длинных сроков фиксации на рынке. С возможностью продления.</div></div>
            <div className="adv-card"><div className="adv-title">Выплата за 5 рабочих дней</div><div className="adv-desc">Один из самых коротких сроков выплаты комиссионного вознаграждения.</div></div>
            <div className="adv-card"><div className="adv-title">Личный кабинет брокера</div><div className="adv-desc">Фиксация клиентов, просмотр комиссии, каталог объектов, статусы сделок.</div></div>
            <div className="adv-card"><div className="adv-title">Прогрессивная шкала 5-8%</div><div className="adv-desc">Накопительная программа по агентству. Квартальные бонусы сверху.</div></div>
            <div className="adv-card"><div className="adv-title">Рекламные материалы</div><div className="adv-desc">Готовые тексты, визуалы для соцсетей, брошюры, планировки, видео.</div></div>
          </div>
        </section>

        <hr className="sep" />

        {/* COOPERATION */}
        <section id="cooperation">
          <div className="sh"><div className="sh-tag">Условия сотрудничества</div><h2>Всё прозрачно — <em>документы</em></h2></div>
          <div className="coop-grid">
            <div className="coop-left">
              <p>Мы рассматриваем сотрудничество с позиции «выиграл-выиграл». Все условия зафиксированы в документах и доступны в личном кабинете.</p>
              <button className="btn-gold" onClick={handleRegister}>Стать партнёром</button>
            </div>
            <div className="doc-list">
              <div className="doc-item"><div className="doc-name">Как начать сотрудничать с ST MICHAEL</div><div className="doc-dl">&darr;</div></div>
              <div className="doc-item"><div className="doc-name">Регламент работы с партнёрами</div><div className="doc-dl">&darr;</div></div>
              <div className="doc-item"><div className="doc-name">Условия комиссионного вознаграждения</div><div className="doc-dl">&darr;</div></div>
              <div className="doc-item"><div className="doc-name">Вопрос — ответ для брокеров</div><div className="doc-dl">&darr;</div></div>
            </div>
          </div>
        </section>

        {/* COMMUNITY */}
        <section className="s-comm">
          <div><div className="sh-tag">Сообщество</div><h2><strong>ST MICHAEL</strong> Партнёры</h2></div>
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

        {/* FINAL CTA */}
        <section className="s-cta">
          <div className="sh sh-center" style={{marginBottom:0}}><div className="sh-tag">Начните сегодня</div><h2>Присоединяйтесь к <em>партнёрской программе</em></h2><p className="sh-sub">Регистрация за 2 минуты. Личный кабинет, прозрачные условия, быстрые выплаты.</p></div>
          <div style={{display:'flex',justifyContent:'center',gap:12,flexWrap:'wrap',marginTop:36}}>
            <button className="btn-gold" onClick={handleRegister}>Стать партнёром</button>
            <button className="btn-outline" onClick={handleCabinet}>Войти в кабинет</button>
          </div>
        </section>

        {/* FOOTER */}
        <footer>
          <div className="foot-grid">
            <div><div className="foot-logo">ST MICHAEL</div><div className="foot-logo-sub">Кабинет брокера</div></div>
            <div><div className="foot-col-title">Условия</div><a className="foot-link" href="#cooperation">Условия сотрудничества</a><a className="foot-link" href="#events">Календарь событий</a><a className="foot-link" href="#commission">Комиссия</a></div>
            <div><div className="foot-col-title">Проекты</div><span className="foot-link" onClick={handleCabinet} style={{cursor:'pointer'}}>Зорге 9</span><span className="foot-link" onClick={handleCabinet} style={{cursor:'pointer'}}>Серебряный Бор</span></div>
            <div><div className="foot-col-title">Партнёрам</div><a className="foot-link" href="tel:+74951504010">+7 (495) 150-40-10</a><a className="foot-link" href="mailto:broker@stmichael.ru">broker@stmichael.ru</a><a className="foot-link" href="https://t.me/stmichaelBroker">Telegram</a></div>
          </div>
          <div className="foot-bottom"><span>&copy; 2026 ST MICHAEL. Все права защищены.</span><span>Данные носят ориентировочный характер.</span></div>
        </footer>

        <button className="float-btn" onClick={()=>window.open('https://wa.me/74951504010','_blank')}>Связаться с нами</button>
      </div>

      {authModal && (
        <AuthModal
          mode={authModal}
          onClose={() => setAuthModal(null)}
          onSwitch={() => setAuthModal(authModal === 'login' ? 'register' : 'login')}
          onSuccess={() => { setAuthModal(null); router.push('/fixation'); }}
        />
      )}
    </>
  );
}
