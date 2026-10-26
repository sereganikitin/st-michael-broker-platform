'use strict';
const fs=require('node:fs'),path=require('node:path');
for(const [file,globalName] of [['plan.cjs','__partnerSheetPlan'],['match.cjs','__partnerSheetMatch'],['transfer-plan.cjs','__partnerSheetTransfer'],['registry.cjs','__partnerSheetRegistry']])process.stdout.write('(function(){const module={exports:{}};'+fs.readFileSync(path.join(__dirname,file),'utf8')+'\nglobalThis.'+globalName+'=module.exports;})();\n');
process.stdout.write(fs.readFileSync(path.join(__dirname,'probe.cjs'),'utf8'));
