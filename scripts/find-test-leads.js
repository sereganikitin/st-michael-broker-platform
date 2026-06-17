#!/usr/bin/env node
/**
 * Поиск «тестовых» лидов в amoCRM — кандидатов на удаление.
 * НИЧЕГО НЕ УДАЛЯЕТ. Только печатает список.
 *
 * Эвристика «тестовый»:
 *   - имя лида или контакта содержит: test, тест, asdf, qwer, broker_test
 *   - имя контакта = повтор одного слова ("test1 test1 test1")
 *   - имя контакта целиком 1–2 символа (одна буква, "А" / "Б")
 *
 * Запуск: workflow seed-data, task=find-test-leads
 */

const PIPELINES = {
  7600542: 'КЦ',
  7600546: 'Берзарина(СБ)',
  7600550: 'Зорге9',
  7600554: 'Толбухина',
  10787390: 'Брокеры',
};

const TEST_QUERIES = ['test', 'тест', 'asdf', 'qwer', 'broker_test'];
const TEST_RE = /(test|тест|asdf|qwer|broker_test)/i;

(async () => {
  const subdomain = process.env.AMO_SUBDOMAIN || 'stmichael';
  const domain = process.env.AMO_BASE_DOMAIN || 'amocrm.ru';
  const apiDomain = process.env.AMO_API_DOMAIN || `${subdomain}.${domain}`;
  const BASE = `https://${apiDomain}/api/v4`;
  const TOKEN = process.env.AMO_ACCESS_TOKEN;
  if (!TOKEN) {
    console.error('AMO_ACCESS_TOKEN missing');
    process.exit(1);
  }

  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  async function searchLeads(query) {
    const out = [];
    let page = 1;
    while (true) {
      const url = `${BASE}/leads?query=${encodeURIComponent(query)}&with=contacts&limit=250&page=${page}`;
      const r = await fetch(url, { headers });
      if (r.status === 204 || r.status === 404) break;
      if (!r.ok) {
        console.error(`HTTP ${r.status} on query=${query} page=${page}`);
        break;
      }
      const data = await r.json();
      const leads = data?._embedded?.leads || [];
      if (!leads.length) break;
      out.push(...leads);
      if (leads.length < 250) break;
      page++;
      if (page > 20) break;
    }
    return out;
  }

  const contactCache = new Map();
  async function getContactName(id) {
    if (contactCache.has(id)) return contactCache.get(id);
    try {
      const r = await fetch(`${BASE}/contacts/${id}`, { headers });
      if (!r.ok) { contactCache.set(id, ''); return ''; }
      const c = await r.json();
      const name = String(c?.name || '').trim();
      contactCache.set(id, name);
      return name;
    } catch {
      contactCache.set(id, '');
      return '';
    }
  }

  function looksTest(name) {
    if (!name) return false;
    if (TEST_RE.test(name)) return true;
    const cleaned = name.replace(/\s+/g, '');
    if (cleaned.length <= 2) return true;
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2 && parts.every((p) => p === parts[0])) return true;
    return false;
  }

  // 1) Поисковые запросы по подстроке
  const seen = new Map(); // leadId -> lead
  for (const q of TEST_QUERIES) {
    const leads = await searchLeads(q);
    console.log(`query "${q}": найдено ${leads.length} лидов`);
    for (const l of leads) seen.set(l.id, l);
  }

  // 2) Резолвим имя контакта для каждого и фильтруем
  const candidates = [];
  for (const lead of seen.values()) {
    const leadName = String(lead.name || '');
    const contactRefs = lead._embedded?.contacts || [];
    let cname = '';
    for (const ref of contactRefs) {
      if (!ref?.id) continue;
      const n = await getContactName(ref.id);
      if (n) { cname = n; break; }
    }
    if (looksTest(leadName) || looksTest(cname)) {
      candidates.push({
        leadId: lead.id,
        pipelineId: lead.pipeline_id,
        pipelineName: PIPELINES[lead.pipeline_id] || `?${lead.pipeline_id}`,
        statusId: lead.status_id,
        createdAt: lead.created_at ? new Date(lead.created_at * 1000).toISOString().slice(0, 10) : '—',
        leadName,
        contactName: cname,
      });
    }
  }

  candidates.sort((a, b) => String(a.pipelineName).localeCompare(String(b.pipelineName)) || a.leadId - b.leadId);

  console.log(`\n═══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`Кандидаты на удаление: ${candidates.length}`);
  console.log(`═══════════════════════════════════════════════════════════════════════════════════`);
  console.log(
    `leadId    | pipeline       | status   | created    | leadName                       | contactName`,
  );
  console.log(
    `----------|----------------|----------|------------|--------------------------------|------------`,
  );
  for (const c of candidates) {
    console.log(
      `${String(c.leadId).padEnd(9)} | ${c.pipelineName.padEnd(14)} | ${String(c.statusId).padEnd(8)} | ${c.createdAt.padEnd(10)} | ${c.leadName.slice(0, 30).padEnd(30)} | ${c.contactName}`,
    );
  }
  console.log(`\nЕсли список ОК — следующим шагом запустим delete-test-leads с этими ID.`);
})().catch((e) => {
  console.error('Error:', e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
