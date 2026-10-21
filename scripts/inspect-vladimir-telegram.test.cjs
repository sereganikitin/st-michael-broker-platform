const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {candidateIds,equalName}=require('./inspect-vladimir-telegram.cjs');
const {spawnSync}=require('node:child_process');
test('only the two exact user-authorized usernames may be inspected',()=>{
 const source="const m=require('./scripts/inspect-vladimir-telegram.cjs');if(!m.equalName('@VishStMichael')||m.equalName('wladimirvarrior'))process.exit(2)";
 assert.equal(spawnSync(process.execPath,['-e',source],{env:{...process.env,TARGET_TELEGRAM_USERNAME:'vishstmichael'}}).status,0);
 assert.notEqual(spawnSync(process.execPath,['-e',source],{env:{...process.env,TARGET_TELEGRAM_USERNAME:'unapproved'}}).status,0);
});
test('exact username only, private positive IDs and deduplication',()=>{assert.equal(equalName('@WladimirVarrior'),true);assert.deepEqual(candidateIds([{chatId:'123',fromUsername:'wladimirvarrior'},{chatId:'-555',fromUsername:'wladimirvarrior'},{chatId:'777',fromUsername:'someone'}],{users:{123:{username:'wladimirvarrior',chatId:'123',active:true}}}),['123']);});
test('inactive or unbound users are not accepted',()=>{assert.deepEqual(candidateIds([],{users:{123:{username:'wladimirvarrior',chatId:'456',active:true},789:{username:'wladimirvarrior',chatId:'789',active:false}}}),[]);});
test('no polling takeover, messages, mutations or private contents in projection',()=>{const s=fs.readFileSync('scripts/inspect-vladimir-telegram.cjs','utf8');assert.match(s,/default_transaction_read_only=on/);assert.doesNotMatch(s,/['"]getUpdates['"]|method:'POST'|\.upsert\(|\.update\(/);assert.match(s,/select:\{chatId:true,fromUsername:true,sentAt:true\}/);const projection=s.slice(s.indexOf("console.log('VLADIMIR_TELEGRAM='"));assert.doesNotMatch(projection,/chatId:|fromName:|token:/);});
