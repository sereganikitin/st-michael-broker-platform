import assert from 'node:assert/strict';
import test from 'node:test';
import { findInstallmentCalculator, materialDownloadAttributes, safeMaterialUrl, type MaterialActionDocument } from './materials-actions';

const origin = 'https://broker.stmichael.ru';
const calculator: MaterialActionDocument = {
  name: 'Калькулятор рассрочки: Серебряный Бор, Зорге 9, машино-места',
  description: '[seed:cooperation-calculator-rassrochki-2026-09]',
  category: 'cooperation', type: 'HTML', isPublic: true,
  fileUrl: '/files/cooperation/calculator-rassrochki-2026-09.html',
  updatedAt: '2026-09-30T09:32:12.422Z', sortOrder: 1,
};

test('relative files are local without browser globals and paths do not depend on open folder', () => {
  assert.deepEqual(safeMaterialUrl('/files/Фото лето*.jpg'), { href: '/files/%D0%A4%D0%BE%D1%82%D0%BE%20%D0%BB%D0%B5%D1%82%D0%BE*.jpg', isLocal: true });
  assert.deepEqual(safeMaterialUrl('files/movie.MOV?download=1#preview'), { href: '/files/movie.MOV?download=1#preview', isLocal: true });
  assert.deepEqual(safeMaterialUrl('./files/movie.MOV'), { href: '/files/movie.MOV', isLocal: true });
  assert.deepEqual(safeMaterialUrl('/files/100%25.jpg'), { href: '/files/100%25.jpg', isLocal: true });
  assert.deepEqual(safeMaterialUrl('/files/%D0%A4%D0%BE%D1%82%D0%BE.jpg'), { href: '/files/%D0%A4%D0%BE%D1%82%D0%BE.jpg', isLocal: true });
});

test('download attributes retain actual Unicode names and cover stars without fetching audio/video', () => {
  assert.deepEqual(materialDownloadAttributes({ name: 'Вечерний Зорге — 1***.MOV', fileUrl: '/files/actual.MOV' }), {
    href: '/files/actual.MOV', download: 'Вечерний Зорге — 1***.MOV', label: 'Скачать',
  });
  assert.deepEqual(materialDownloadAttributes({ name: 'Презентация', fileUrl: '/files/opaque.pdf?signature=original' }), {
    href: '/files/opaque.pdf?signature=original', download: 'Презентация.pdf', label: 'Скачать',
  });
});

test('missing name falls back to decoded resource filename and cleans forbidden filename characters', () => {
  assert.equal(materialDownloadAttributes({ fileUrl: '/files/%D0%A4%D0%BE%D1%82%D0%BE%2520.jpg' })?.download, 'Фото%20.jpg');
  assert.equal(materialDownloadAttributes({ fileUrl: '/files/file', name: '../bad\\file\u0000.pdf' })?.download, '.._bad_file_.pdf');
  assert.equal(materialDownloadAttributes({ fileUrl: '/files/opaque', name: '..' })?.download, 'opaque');
});

test('absolute same origin requires exact protocol hostname and port supplied by caller', () => {
  assert.equal(materialDownloadAttributes({ name: 'offer.pdf', fileUrl: `${origin}/files/offer.pdf` })?.label, 'Открыть оригинал');
  assert.equal(materialDownloadAttributes({ name: 'offer.pdf', fileUrl: `${origin}/files/offer.pdf` }, origin)?.download, 'offer.pdf');
  assert.equal(safeMaterialUrl(`${origin}:443/files/offer.pdf`, origin)?.isLocal, true);
  for (const host of ['https://broker.stmichael.ru.evil.test', 'https://evil-broker.stmichael.ru', 'http://broker.stmichael.ru', 'https://broker.stmichael.ru:444', 'https://xn--brokr-q51b.example']) {
    const action = materialDownloadAttributes({ name: 'offer.pdf', fileUrl: `${host}/files/offer.pdf` }, origin);
    assert.deepEqual(action, { href: `${host}/files/offer.pdf`, target: '_blank', rel: 'noopener noreferrer', label: 'Открыть оригинал' });
  }
});

test('invalid browser origins never grant local download permission to absolute URLs', () => {
  for (const invalid of ['not-url', 'https://broker.stmichael.ru/other', `${origin}?origin=true`, `https://user@broker.stmichael.ru`, `${origin}\n`, 'javascript:alert(1)']) {
    assert.equal(safeMaterialUrl(`${origin}/files/offer.pdf`, invalid)?.isLocal, false);
  }
});

test('legitimate external HTTP storage links open originals, not pretend to download', () => {
  const href = 'https://disk.360.yandex.ru/d/example?download=1';
  assert.deepEqual(materialDownloadAttributes({ name: 'Материалы', fileUrl: href }), { href, target: '_blank', rel: 'noopener noreferrer', label: 'Открыть оригинал' });
  assert.equal(materialDownloadAttributes({ fileUrl: 'http://storage.example/original.mp4' })?.label, 'Открыть оригинал');
});

test('malicious schemes controls credentials protocol-relative paths and traversal are rejected', () => {
  for (const href of [
    '', '//evil.test/file.pdf', '///evil.test/file.pdf', '\\evil.test\\file.pdf', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)',
    'data:text/html,<script>evil</script>', 'blob:https://broker.stmichael.ru/id', 'file:///C:/secret', 'mailto:broker@stmichael.ru',
    'https:evil.test/file', 'https://user:password@evil.test/file', `https://broker.stmichael.ru@evil.test/file`,
    './//evil.test/file.pdf', './javascript:alert(1)',
    '/files/../secret.pdf', '/files/%2e%2e/secret.pdf', '/files/%252e%252e/secret.pdf', '/files/%2e/secret.pdf',
    'https://storage.example/files/../secret.pdf', '/%2f%2fevil.test/file', '/files/%5csecret.pdf', '/files/%0d%0afile.pdf',
    '/files/bad%ZZ.pdf', '/files/secret\n.pdf', '/files/secret\t.pdf', '../files/file.pdf', '?download=1', '#preview',
    'javascript%3Aalert(1)', '/files/%25252525252e%25252525252e/secret.pdf',
  ]) {
    assert.equal(safeMaterialUrl(href, origin), null, href);
    assert.equal(materialDownloadAttributes({ fileUrl: href }, origin), null, href);
  }
  for (const invalid of [null, undefined, 5, {}, []]) assert.equal(safeMaterialUrl(invalid), null);
});

test('current actual public cooperation calculator metadata resolves without hardcoded fallback', () => {
  const docs = [{ name: 'Условия сотрудничества сентябрь', type: 'PDF', fileUrl: '/files/cooperation/terms.pdf' }, calculator];
  assert.equal(findInstallmentCalculator(docs), calculator.fileUrl);
  assert.equal(findInstallmentCalculator([{ ...calculator, fileUrl: '/files/cooperation/new-calculator.html' }]), '/files/cooperation/new-calculator.html');
  assert.equal(findInstallmentCalculator(null), null);
  assert.equal(findInstallmentCalculator(undefined), null);
  assert.equal(findInstallmentCalculator([]), null);
});

test('calculator requires HTML plus calculator and installment semantics', () => {
  assert.equal(findInstallmentCalculator([{ name: 'Калькулятор рассрочки', type: 'XLSX', fileUrl: '/files/terms.xlsx' }]), null);
  assert.equal(findInstallmentCalculator([{ name: 'Условия рассрочки', type: 'PDF', fileUrl: '/files/terms.pdf' }]), null);
  assert.equal(findInstallmentCalculator([{ name: 'Ипотечный калькулятор', type: 'HTML', fileUrl: '/files/mortgage.html' }]), null);
  assert.equal(findInstallmentCalculator([{ name: 'Калькулятор рассрочки.html', type: 'HTML', fileUrl: '/files/report.PDF' }]), null);
  assert.equal(findInstallmentCalculator([{ name: 'Калькулятор рассрочки', type: 'text/html; charset=utf-8', fileUrl: '/files/download?id=opaque' }]), '/files/download?id=opaque');
  assert.equal(findInstallmentCalculator([{ name: 'Calculator instalments', type: 'HTML', fileUrl: '/files/calculator.html' }]), '/files/calculator.html');
  assert.equal(findInstallmentCalculator([{ name: 'Документ', fileUrl: '/files/calculator-rassrochki.HTML?version=3' }]), '/files/calculator-rassrochki.HTML?version=3');
});

test('calculator selection excludes unsafe/private docs and uses latest metadata without changing input', () => {
  const docs = [
    { ...calculator, fileUrl: 'javascript:alert(1)' },
    { ...calculator, fileUrl: '/files/private-calculator.html', isPublic: false },
    { ...calculator, fileUrl: '/files/old-calculator.html', updatedAt: '2026-08-01T00:00:00Z' },
    { ...calculator, fileUrl: '/files/new-calculator.html', updatedAt: '2026-10-01T00:00:00Z' },
  ];
  const snapshot = JSON.stringify(docs);
  assert.equal(findInstallmentCalculator(docs), '/files/new-calculator.html');
  assert.equal(JSON.stringify(docs), snapshot);
});

test('calculator selection prefers meaningful name then API ordering when dates tie', () => {
  assert.equal(findInstallmentCalculator([
    { ...calculator, name: 'Документ', fileUrl: '/files/calculator-rassrochki.html', updatedAt: '2026-10-01T00:00:00Z' },
    calculator,
  ]), calculator.fileUrl);
  assert.equal(findInstallmentCalculator([
    { ...calculator, fileUrl: '/files/later.html', sortOrder: 5 },
    { ...calculator, fileUrl: '/files/first.html', sortOrder: 0 },
  ]), '/files/first.html');
});
