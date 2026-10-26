'use strict';
const fs=require('node:fs'),path=require('node:path');
process.stdout.write('(function(){const module={exports:{}};'+fs.readFileSync(path.join(__dirname,'plan.cjs'),'utf8')+'\nglobalThis.__partnerSheetPlan=module.exports;})();\n'+fs.readFileSync(path.join(__dirname,'probe.cjs'),'utf8'));
