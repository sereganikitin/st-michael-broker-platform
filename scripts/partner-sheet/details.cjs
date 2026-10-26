'use strict';
const {createHash}=require('node:crypto');
const {normalize,TABS}=require('./plan.cjs');
// Only already validated agency rows are read. Never read the contact/call tabs
// or contact cells belonging to excluded individual broker rows.
const COLUMNS=[1,4,5,6,7,8,9,10,11,12,13,14,15,19,20,21,22,23,24];
const HEADERS=['№','Приоритет','Партнёр','Тип','Скрипт звонка','Номер телефона','Имя агента','Дата звонка','Статус контакта','Ответственный менеджер','Следующий контакт','Результат / комментарий','Публикация на сайте','Что нужно для размещения на сайте','Выездной БТ — результат','Последний ДДУ',null,'Новые сделки ИТОГ — НЕ ВВОДИТЬ, млн ₽','Сумма итог, млн ₽',null,'Текущая комиссия','Следующая комиссия','До следующего шага, млн ₽','Комиссия сообщена брокеру','Сигнал отдела'];
async function readAgencyDetails(sheets,spreadsheetId,source){
 const details=[];
 for(const tab of TABS.slice(0,3)){
  const rows=source.sourceRows.filter(r=>r.tab===tab);
  const ranges=[`'${tab}'!A5:Y5`,...rows.map(r=>`'${tab}'!A${r.row}:Y${r.row}`)];
  const response=await sheets.spreadsheets.values.batchGet({spreadsheetId,ranges,valueRenderOption:'FORMATTED_VALUE'},{timeout:10000});
  const values=(response.data.valueRanges||[]).map(r=>r.values?.[0]||[]),headers=values[0];
  if(values.length!==ranges.length||!headers||HEADERS.some((h,i)=>h!==null&&normalize(headers[i])!==normalize(h)))throw Error('SOURCE_SCHEMA_CHANGED');
  const expectedBaseline=tab==='Спящие'?'Исторические продажи до 2026, млн ₽ (не считать)':'Сумма на старте, млн ₽';
  const expectedCommission=tab==='Спящие'?'На первую сделку до 30.09':'Комиссия с 01.09';
  if(normalize(headers[16])!==normalize(expectedBaseline)||normalize(headers[19])!==normalize(expectedCommission))throw Error('SOURCE_SCHEMA_CHANGED');
  rows.forEach((row,index)=>{
   const cells=values[index+1];
   if(normalize(cells[2])!==row.normalizedName||String(cells[3]||'').trim()!==row.type)throw Error('SOURCE_CHANGED_DURING_READ');
   details.push({tab,row:row.row,fields:COLUMNS.map(i=>({column:String.fromCharCode(65+i),label:headers[i],value:String(cells[i]??'')}))});
  });
 }
 return {...source,details,contentHash:createHash('sha256').update(JSON.stringify({core:source.contentHash,details})).digest('hex')};
}
module.exports={readAgencyDetails,COLUMNS,HEADERS};
