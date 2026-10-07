import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { lockSidebarBodyScroll, SIDEBAR_BODY_OPEN_CLASS } from './sidebar-scroll';

const sidebar = readFileSync(new URL('../components/Sidebar.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../components/Sidebar.module.css', import.meta.url), 'utf8');
const globals = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
const helper = readFileSync(new URL('./sidebar-scroll.ts', import.meta.url), 'utf8');

function classes(initial: string[] = []) {
  const values = new Set(initial);
  return {
    values,
    contains: (value: string) => values.has(value),
    add: (value: string) => { values.add(value); },
    remove: (value: string) => { values.delete(value); },
  };
}

test('opening and closing the sidebar owns only its body class', () => {
  const bodyClasses = classes(['unrelated-overlay']);
  const release = lockSidebarBodyScroll(bodyClasses);
  assert.equal(bodyClasses.contains(SIDEBAR_BODY_OPEN_CLASS), true);
  assert.equal(bodyClasses.contains('unrelated-overlay'), true);
  release();
  assert.deepEqual([...bodyClasses.values], ['unrelated-overlay']);
});

test('cleanup preserves a pre-existing sidebar class it does not own', () => {
  const bodyClasses = classes([SIDEBAR_BODY_OPEN_CLASS, 'another-owner']);
  lockSidebarBodyScroll(bodyClasses)();
  assert.deepEqual([...bodyClasses.values], [SIDEBAR_BODY_OPEN_CLASS, 'another-owner']);
});

test('cleanup can run repeatedly without clearing unrelated locks', () => {
  const bodyClasses = classes(['material-viewer']);
  const release = lockSidebarBodyScroll(bodyClasses);
  release();
  release();
  assert.deepEqual([...bodyClasses.values], ['material-viewer']);
});

test('sidebar lock never writes inline overflow used by existing modal viewers', () => {
  assert.doesNotMatch(helper, /\.style|\.overflow|setAttribute|removeAttribute/);
});

test('the mobile panel is a bounded flex column with dynamic viewport fallback', () => {
  const mobilePanel = css.match(/\.panel\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(mobilePanel, /display:\s*flex/);
  assert.match(mobilePanel, /flex-direction:\s*column/);
  assert.match(mobilePanel, /height:\s*100vh;[\s\S]*height:\s*100dvh;/);
  assert.match(mobilePanel, /min-height:\s*0/);
  assert.match(mobilePanel, /overflow:\s*hidden/);
  assert.match(sidebar, /styles\.panel/);
  assert.doesNotMatch(sidebar, /\bh-full\b/);
});

test('long navigation scrolls independently without shrinking the header', () => {
  const mobileNav = css.match(/\.navigation\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(mobileNav, /flex:\s*1/);
  assert.match(mobileNav, /min-height:\s*0/);
  assert.match(mobileNav, /overflow-y:\s*auto/);
  assert.match(mobileNav, /overflow-x:\s*hidden/);
  assert.match(sidebar, /className="p-6 flex shrink-0 /);
  assert.match(sidebar, /<nav className=\{cn\('px-4', styles\.navigation\)\}/);
});

test('touch scrolling and safe-area spacing keep the final links reachable', () => {
  assert.match(css, /overscroll-behavior-y:\s*contain/);
  assert.match(css, /touch-action:\s*pan-y pinch-zoom/);
  assert.match(css, /-webkit-overflow-scrolling:\s*touch/);
  assert.match(css, /padding-bottom:\s*calc\([^;]+env\(safe-area-inset-bottom,\s*0px\)/);
  assert.doesNotMatch(sidebar + css, /touch-action:\s*none|onTouchMove|preventDefault/);
  assert.match(sidebar, /href:\s*'\/admin\/integrations'/);
  assert.match(sidebar, /items\.map\(\(item\)/);
});

test('desktop retains the natural sidebar and document scrolling at the lg breakpoint', () => {
  const desktop = css.slice(css.indexOf('@media (min-width: 1024px)'));
  assert.match(desktop, /\.panel\s*\{[^}]*height:\s*auto;[^}]*overflow:\s*visible/);
  assert.match(desktop, /\.navigation\s*\{[^}]*flex:\s*initial;[^}]*overflow:\s*visible/);
  assert.match(sidebar, /lg:static lg:translate-x-0 lg:z-auto/);
});

test('body lock applies only below desktop and matches the owned class', () => {
  assert.match(globals, new RegExp(`@media not all and \\(min-width: 1024px\\)\\s*\\{\\s*body\\.${SIDEBAR_BODY_OPEN_CLASS}\\s*\\{\\s*overflow:\\s*hidden;\\s*\\}\\s*\\}`));
});

test('the effect releases the body lock on close/unmount and navigation still closes the menu', () => {
  assert.match(sidebar, /useEffect\(\(\) => \{\s*if \(!open\) return;\s*return lockSidebarBodyScroll\(document\.body\.classList\);\s*\}, \[open\]\)/);
  assert.match(sidebar, /aria-label="Закрыть меню"/);
  assert.match(sidebar, /aria-label="Основное меню кабинета"/);
  assert.match(sidebar, /href=\{item\.href\}\s*onClick=\{onClose\}/);
});
