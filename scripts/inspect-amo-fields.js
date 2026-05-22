#!/usr/bin/env node
/**
 * Инспектор custom_fields в amoCRM. Печатает все поля Lead и Contact
 * с их ID, типом, и enum-значениями (для select/radio полей).
 *
 * Использование (внутри контейнера api):
 *   docker exec st-michael-api node /app/scripts/inspect-amo-fields.js
 *   docker exec st-michael-api node /app/scripts/inspect-amo-fields.js --grep "От брокера"
 *   docker exec st-michael-api node /app/scripts/inspect-amo-fields.js --entity leads
 *   docker exec st-michael-api node /app/scripts/inspect-amo-fields.js --entity contacts
 *
 * Нужны env: AMO_ACCESS_TOKEN, AMO_SUBDOMAIN (по умолчанию 'stmichael'),
 *            AMO_BASE_DOMAIN (по умолчанию 'amocrm.ru').
 */

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  const next = args[i + 1];
  if (!next || next.startsWith('--')) return true;
  return next;
}

const grep = arg('grep');
const onlyEntity = arg('entity'); // 'leads' | 'contacts' | null = both

const SUBDOMAIN = process.env.AMO_SUBDOMAIN || 'stmichael';
const BASE = process.env.AMO_BASE_DOMAIN || 'amocrm.ru';
const TOKEN = process.env.AMO_ACCESS_TOKEN;

if (!TOKEN) {
  console.error('AMO_ACCESS_TOKEN не установлен в env');
  process.exit(2);
}

const API = `https://${SUBDOMAIN}.${BASE}/api/v4`;

async function fetchAllFields(entity) {
  const all = [];
  let url = `${API}/${entity}/custom_fields?limit=50`;
  let pageNum = 1;
  while (url) {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    });
    if (!r.ok) {
      console.error(`ERR ${entity} page ${pageNum}: HTTP ${r.status}`);
      const txt = await r.text().catch(() => '');
      console.error(txt.slice(0, 500));
      break;
    }
    const data = await r.json();
    const fields = data?._embedded?.custom_fields || [];
    all.push(...fields);
    const next = data?._links?.next?.href;
    if (!next) break;
    url = next;
    pageNum++;
  }
  return all;
}

function printFields(entity, fields) {
  console.log('━'.repeat(80));
  console.log(`  ${entity.toUpperCase()}  (всего полей: ${fields.length}${grep ? `, фильтр: "${grep}"` : ''})`);
  console.log('━'.repeat(80));
  for (const f of fields) {
    const name = String(f.name || '');
    if (grep && !name.toLowerCase().includes(String(grep).toLowerCase())) continue;
    console.log(`\nID=${f.id}  type=${f.type}  code=${f.code || '-'}`);
    console.log(`  name:  "${name}"`);
    if (Array.isArray(f.enums) && f.enums.length > 0) {
      console.log('  enums:');
      for (const e of f.enums) {
        console.log(`    [${e.id}] "${e.value}"${e.sort != null ? ` (sort=${e.sort})` : ''}`);
      }
    }
    if (f.group_id) console.log(`  group_id: ${f.group_id}`);
    if (f.required_statuses?.length > 0) {
      console.log(`  required_statuses: ${f.required_statuses.map(s => `pipeline=${s.pipeline_id} status=${s.status_id}`).join(', ')}`);
    }
  }
}

(async () => {
  console.log(`Inspecting amoCRM @ ${SUBDOMAIN}.${BASE}\n`);

  if (!onlyEntity || onlyEntity === 'leads') {
    const leadFields = await fetchAllFields('leads');
    printFields('leads', leadFields);
  }

  if (!onlyEntity || onlyEntity === 'contacts') {
    const contactFields = await fetchAllFields('contacts');
    printFields('contacts', contactFields);
  }

  console.log('\n━'.repeat(80));
  console.log('Готово. Чтобы найти конкретное поле:');
  console.log('  --grep "От брокера" — отфильтрует поля по подстроке в name');
  console.log('  --entity leads      — только лиды');
  console.log('  --entity contacts   — только контакты');
})().catch((e) => {
  console.error('FATAL:', e?.message || e);
  process.exit(1);
});
