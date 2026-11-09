const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const code = source.slice(source.indexOf('async function requestApi('), source.indexOf('function stopRealtimeSync('));
async function request(reply) { return new Function('fetch', code + '; return requestApi;')(async () => reply)('/api/bills', {method:'POST',body:{operationId:'same-operation'}}); }
(async () => {
  for (const text of ['', '{']) {
    await assert.rejects(request({ok:true,status:200,text:async()=>text}), error => error.status===502 && error.code==='INVALID_API_RESPONSE');
    console.log('PASS incomplete successful response remains an unconfirmed operation');
  }
  await assert.rejects(request({ok:false,status:409,text:async()=>JSON.stringify({error:'Changed elsewhere',code:'CONFLICT'})}), error=>error.status===409 && error.code==='CONFLICT');
  console.log('PASS conflict status is retained for safe retry handling');
  assert.deepEqual(await request({ok:true,status:200,text:async()=>JSON.stringify({bill:{id:'saved'}})}),{bill:{id:'saved'}});
  console.log('PASS complete save response is returned');
})().catch(error=>{console.error(error);process.exitCode=1;});
