const { test } = require('node:test');
const assert = require('node:assert/strict');
const { material, coverTargets, buildLayout, replaceable } = require('./materials-new-version');
const make = (name, folder = 'Зорге 9/Фото/Лобби') => material({ name, path: '/Новая версия/' + folder + '/' + name, size: 100 });
const saved = { version: 1, groups: [], rules: [{ prefix: 'ЗОРГЕ 9', groupId: 'zorge' }, { prefix: 'Условия сотрудничества', groupId: null }], covers: { 'Зорге 9/Фото': 'old', 'Условия сотрудничества': 'keep' }, looseFolders: { 'Зорге 9/Видео': 'УТП' } };
test('one/two stars and explicit triple-video destination', () => {
  assert.deepEqual(coverTargets(make('Лобби*.jpg')), ['Зорге 9/Фото/Лобби']);
  assert.deepEqual(coverTargets(make('Лобби**.jpg')), ['Зорге 9/Фото/Лобби', 'Зорге 9/Фото']);
  const triple = make('Вечерний Зорге — 1***.MOV', 'Зорге 9/Видео/Теплый период — весна, лето, осень');
  assert.deepEqual(coverTargets(triple), [triple.folder, 'Зорге 9/Видео']);
  assert.throws(() => coverTargets(make('Неизвестно***.jpg')));
});
test('preserve hierarchy, replace old covers and virtual folders, keep cooperation', () => {
  const f = make('Лобби**.jpg');
  const layout = buildLayout(saved, [f]);
  assert.equal(layout.covers['Зорге 9/Фото'], f.fileUrl);
  assert.equal(layout.covers['Условия сотрудничества'], 'keep');
  assert.deepEqual(layout.looseFolders, {});
  assert.ok(layout.rules.some(r => r.prefix === 'Зорге 9/Фото' && r.kind === 'as_is' && r.displayName === 'Фото'));
  assert.ok(layout.rules.some(r => r.prefix === 'Условия сотрудничества'));
});
test('case/star filename collisions avoided; traversal/outside source rejected', () => {
  assert.notEqual(make('IMG.MOV').rel.toLowerCase(), make('IMG.mov').rel.toLowerCase());
  assert.notEqual(make('Лобби*.jpg').rel, make('Лобби_.jpg').rel);
  assert.throws(() => material({ name: 'a.jpg', path: '/Старое/a.jpg' }));
});
test('explicit conflicting covers fail closed', () => {
  assert.throws(() => buildLayout(saved, [make('1*.jpg'), make('2*.jpg')]), /Conflicting covers/);
});
test('single-star folder cover takes priority over ancestor-cover propagation', () => {
  const direct = make('Для папки*.jpg');
  const ancestor = make('Для родителя**.jpg');
  for (const files of [[direct, ancestor], [ancestor, direct]]) {
    const layout = buildLayout(saved, files);
    assert.equal(layout.covers[direct.folder], direct.fileUrl);
    assert.equal(layout.covers['Зорге 9/Фото'], ancestor.fileUrl);
  }
});
test('retirement scoped to old project media, not cooperation or calculator', () => {
  assert.ok(replaceable({ category: 'materials', name: 'old.jpg', subcategory: 'ЗОРГЕ 9/Фото' }, saved));
  assert.ok(!replaceable({ category: 'cooperation', name: 'old.jpg', project: 'ZORGE9' }, saved));
  assert.ok(!replaceable({ category: 'materials', name: 'Условия.pdf', project: 'ZORGE9' }, saved));
  assert.ok(!replaceable({ category: 'materials', name: 'calculator.html', project: 'SILVER_BOR' }, saved));
});
