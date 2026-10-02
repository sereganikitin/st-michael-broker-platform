'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { MATERIALS_CATALOG_HREF, MATERIALS_CONDITIONS_HREF } from '@/lib/materials-browser';
import { safeMaterialUrl } from '@/lib/materials-actions';
import styles from './public-header.module.css';

export interface PublicHeaderProps {
  /** Resolved from the current public cooperation documents, never a guessed URL. */
  calculatorHref?: string | null;
  /** Callbacks are only passed by another Client Component (the landing). */
  onOpenTour?: () => void;
  onOpenConditions?: () => void;
  /** Keep anchors on the current home synonym, including /v2. */
  isHome?: boolean;
}

/** Render as a sibling BEFORE page content: never inside a zoomed canvas. */
export function PublicHeader({ calculatorHref, onOpenTour, onOpenConditions, isHome = false }: PublicHeaderProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const menuId = useId();
  const sectionHref = (id: string) => `${isHome ? '' : '/'}#${id}`;
  const resolvedCalculatorHref = safeMaterialUrl(calculatorHref)?.href;

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>('a[href],button:not(:disabled)')?.focus());
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const focusOutside = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (target && !menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    document.addEventListener('focusin', focusOutside);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      document.removeEventListener('focusin', focusOutside);
    };
  }, [open]);

  const openAction = (action: () => void) => {
    // The landing dialog can safely return focus to this persistent trigger,
    // rather than a menu item that is removed in the same React commit.
    close(true);
    action();
  };

  return (
    <header className={styles.header} data-public-header>
      <div className={styles.inner}>
        <Link className={styles.brand} href="/" aria-label="St Michael — главная" data-public-home onClick={() => close()}>
          {/* Existing brand asset, shared with the landing and materials. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/v2/svg/logo.svg" alt="S+ MICHAEL" width={211} height={19} />
          <span>Кабинет брокера</span>
        </Link>
        <div className={styles.actions}>
          {resolvedCalculatorHref ? (
            <a className={`${styles.button} ${styles.calculator}`} href={resolvedCalculatorHref} target="_blank" rel="noopener noreferrer" onClick={() => close()}>
              Калькулятор рассрочки
            </a>
          ) : (
            <button type="button" className={`${styles.button} ${styles.calculator}`} disabled title="Калькулятор пока недоступен">
              Калькулятор рассрочки
            </button>
          )}
          <Link className={`${styles.button} ${styles.registration}`} href="/register" onClick={() => close()}>Регистрация</Link>
          <Link className={`${styles.button} ${styles.login}`} href="/login" onClick={() => close()}>
            <span className={styles.loginFull}>Войти в кабинет брокера</span><span className={styles.loginShort}>Войти</span>
          </Link>
          <button type="button" className={styles.burger} ref={triggerRef} aria-label={open ? 'Закрыть меню' : 'Открыть меню'} aria-expanded={open} aria-controls={menuId}
            onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/v2/svg/burger.svg" alt="" width={40} height={16} />
          </button>
        </div>
        {open && (
          <nav className={styles.menu} id={menuId} ref={menuRef} aria-label="Навигация по сайту">
            <Link href={sectionHref('projects')} onClick={() => close()}>Проекты</Link>
            <Link href={sectionHref('events')} onClick={() => close()}>Мероприятия</Link>
            {onOpenTour ? <button type="button" onClick={() => openAction(onOpenTour)}>Записаться на брокер-тур</button>
              : <Link href={sectionHref('events')} onClick={() => close()}>Записаться на брокер-тур</Link>}
            {onOpenConditions ? <button type="button" onClick={() => openAction(onOpenConditions)}>Документы</button>
              : <Link href={MATERIALS_CONDITIONS_HREF} onClick={() => close()}>Документы</Link>}
            <Link href={MATERIALS_CATALOG_HREF} onClick={() => close()}>Материалы</Link>
            <Link href={sectionHref('contacts')} onClick={() => close()}>Контакты</Link>
          </nav>
        )}
      </div>
    </header>
  );
}
