'use strict';
// Synthetic localhost-only regression. No production requests or credentials.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.AGENCY_UI_URL || 'http://127.0.0.1:3137';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) throw Error('LOCAL_ONLY');
const id = '11111111-1111-4111-8111-111111111111';
const card = { id, name: 'Synthetic agency', type: 'АН', callContacts: [], callContactsVersion: 1, assignments: [], attempts: [], tasks: [], periods: [] };
const payloads = [];
(async () => {
 const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
 try {
  const context = await browser.newContext();
  await context.addInitScript(id => {localStorage.setItem('accessToken','synthetic');localStorage.setItem('stm_onboarding_seen_'+id,'1');},id);
  await context.route('**/*',async route => {
   const u=new URL(route.request().url());
   if(u.origin!==base) return route.abort();
   if(!u.pathname.startsWith('/api/')) return route.continue();
   let body={};
   if(u.pathname==='/api/auth/me') body={id,role:'ADMIN',fullName:'Synthetic admin',agencies:[],status:'ACTIVE'};
   if(u.pathname==='/api/loyalty-workflow/operators') body=[];
   if(u.pathname.endsWith('/contacts')) {const p=route.request().postDataJSON();payloads.push(p);card.callContacts=p.contacts;card.callContactsVersion++;body={version:card.callContactsVersion};}
   if(u.pathname==='/api/loyalty-workflow/agencies-v1-2') body={role:'ADMIN',currentUserId:id,permissions:['READ_ALL','ENTITY_EDIT'],cards:[card],script:{current:false},metrics:{assignedAgencies:0,attemptedAgencies:0,attempts:0,conversationAgencies:0,agreements:0,tasksDue:0,tasksOnTime:0,overdue:0},source:{loadedAt:new Date().toISOString(),stale:false,reviewCount:0},period:{}};
   await route.fulfill({json:body});
  });
  const page=await context.newPage();
  await page.goto(base+'/admin/agencies-v1-2/workspace');
  await page.getByRole('button',{name:'Все доступные',exact:true}).click();
  await page.getByRole('heading',{name:card.name,exact:true}).waitFor();
  await page.getByText('Добавить проверенный контакт',{exact:true}).click();
  await page.getByLabel('Имя контакта',{exact:true}).fill('Synthetic contact');
  await page.getByLabel('Основной телефон контакта',{exact:true}).fill('+70000000000');
  await page.getByLabel('Источник контакта',{exact:true}).fill('Synthetic source');
  await page.getByLabel('Дата проверки',{exact:true}).fill('2026-10-27T09:00');
  assert.equal(await page.getByLabel('Дата проверки',{exact:true}).inputValue(),'2026-10-27T09:00');
  await page.getByRole('button',{name:'Сохранить контакт',exact:true}).click();
  await page.getByRole('article').getByText('Synthetic contact',{exact:true}).waitFor();
  await page.getByRole('complementary').getByText(/\+70000000000/).waitFor();
  assert.equal(payloads.length,1);
  assert.equal(payloads[0].contacts[0].verifiedAt,'2026-10-27T09:00:00+03:00');
  await page.getByRole('button',{name:'Исправить',exact:true}).click();
  assert.equal(await page.getByLabel('Дата проверки',{exact:true}).inputValue(),'2026-10-27T09:00');
  console.log('PASS: real datetime-local fill, contact save payload and edit round trip');
 } finally {await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
