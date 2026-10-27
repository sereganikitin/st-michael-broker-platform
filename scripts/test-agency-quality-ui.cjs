'use strict';
// Synthetic localhost-only form regression. No production data or credentials.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.AGENCY_UI_URL || 'http://127.0.0.1:3137';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) throw Error('LOCAL_ONLY');
const id='11111111-1111-4111-8111-111111111111';
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 try {
  for(const canWrite of [true,false]) {
   const context=await browser.newContext();
   await context.addInitScript(id=>{localStorage.setItem('accessToken','synthetic');localStorage.setItem('stm_onboarding_seen_'+id,'1');},id);
   const reviews=[],payloads=[];
   await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.origin!==base)return route.abort();
    if(!u.pathname.startsWith('/api/'))return route.continue();
    let body={};
    if(u.pathname==='/api/auth/me')body={id,role:'ADMIN',fullName:'Synthetic admin',agencies:[],status:'ACTIVE'};
    if(u.pathname==='/api/loyalty-workflow/operators')body=[];
    if(u.pathname.endsWith('/reviews')) {
     if(route.request().method()==='POST') {
      const p=route.request().postDataJSON();payloads.push(p);
      assert.equal(p.expectedVersion,reviews.length);
      body={...p,id:'review-'+reviews.length,version:reviews.length+1,createdAt:'2026-10-27T09:00:00Z',reviewer:{id,fullName:'Synthetic reviewer'}};
      reviews.unshift(body);
     }else body={reviews};
    }
    if(u.pathname==='/api/loyalty-workflow/agencies-v1-2')body={role:'ADMIN',currentUserId:id,permissions:['READ_ALL',...(canWrite?['CALL_REVIEW']:[])],cards:[{id,name:'Synthetic agency',type:'АН',assignments:[],attempts:[{id:'attempt',assignmentId:'assignment',result:'INFORMED',comment:'Synthetic discussion',occurredAt:'2026-10-27T08:00:00Z',operator:{id,fullName:'Synthetic operator'}}],tasks:[],periods:[],callContacts:[]}],script:{current:false},metrics:{assignedAgencies:0,attemptedAgencies:1,attempts:1,conversationAgencies:1,agreements:0,tasksDue:0,tasksOnTime:0,overdue:0},source:{loadedAt:new Date().toISOString(),stale:false,reviewCount:0},period:{}};
    await route.fulfill({json:body});
   });
   const page=await context.newPage();
   await page.goto(base+'/admin/agencies-v1-2/workspace');
   await page.getByRole('button',{name:'Все доступные',exact:true}).click();
   await page.getByText('Журнал попыток (1) и задач',{exact:true}).click();
   await page.getByText('Ручная проверка качества',{exact:true}).click();
   await page.getByText('Ручная проверка ещё не выполнялась.',{exact:true}).waitFor();
   if(canWrite){
    await page.getByLabel('Актуальное предложение',{exact:true}).selectOption('PASS');
    await page.getByLabel('Обоснование проверки',{exact:true}).fill('Synthetic initial assessment');
    await page.getByRole('button',{name:'Сохранить проверку',exact:true}).click();
    await page.getByText('Проверка №1 сохранена. История сохранена.',{exact:true}).waitFor();
    await page.getByLabel('Обоснование проверки',{exact:true}).fill('Synthetic revised assessment');
    assert.equal(await page.getByRole('button',{name:'Сохранить проверку',exact:true}).isDisabled(),true);
    await page.getByLabel('Причина исправления',{exact:true}).fill('New evidence');
    await page.getByRole('button',{name:'Сохранить проверку',exact:true}).click();
    await page.getByText('Проверка №2 сохранена. История сохранена.',{exact:true}).waitFor();
    await page.reload();
    await page.getByRole('button',{name:'Все доступные',exact:true}).click();
    await page.getByText('Журнал попыток (1) и задач',{exact:true}).click();
    await page.getByText('Ручная проверка качества',{exact:true}).click();
    await page.getByText('Synthetic initial assessment',{exact:true}).waitFor();
    await page.getByText('Synthetic revised assessment',{exact:true}).waitFor();
    assert.equal(payloads.length,2);
    assert.equal(payloads[0].criteria.needsClarified,'NOT_OBSERVABLE');
   }else assert.equal(await page.getByRole('button',{name:'Сохранить проверку',exact:true}).count(),0);
   await context.close();
  }
  console.log('PASS manual QA UI: save, required revision reason, history reload, unknown evidence and read-only role');
 }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
