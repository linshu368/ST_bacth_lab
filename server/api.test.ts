import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import handler, { isAuthenticated } from './api';

function cookie(expires:number,key:string) {
  return `other=a; batch_lab_session=${expires}.${createHmac('sha256',key).update(`batch-lab:${expires}`).digest('hex')}`;
}

test('optional shared password validates signatures, expiry and rotation',()=>{
  const key='test-password';
  assert.equal(isAuthenticated('', ''),true);
  assert.equal(isAuthenticated('',key),false);
  assert.equal(isAuthenticated(cookie(Date.now()+60_000,key),key),true);
  assert.equal(isAuthenticated(cookie(Date.now()-60_000,key),key),false);
  assert.equal(isAuthenticated(cookie(Date.now()+60_000,key),'rotated'),false);
});

async function invoke(body:any, headers:Record<string,string>={},method='POST') {
  let payload=''; const response:any={statusCode:200,headers:{} as Record<string,string>,setHeader(name:string,value:string){this.headers[name]=value;},end(value:string){payload=value;}};
  await handler({method,headers:{host:'localhost:3004',...headers},body} as any,response);
  return {status:response.statusCode,headers:response.headers,body:JSON.parse(payload)};
}

test('password gate and origin checks apply before any database operation',async()=>{
  const original=process.env.BATCH_LAB_ACCESS_KEY;
  process.env.BATCH_LAB_ACCESS_KEY='test-password';
  try {
    const denied=await invoke({op:'listBatchLabDatasets'});
    assert.equal(denied.status,401); assert.equal(denied.body.error.code,'AUTH_REQUIRED');
    const crossSite=await invoke({op:'login',input:{accessKey:'test-password'}},{origin:'https://unrelated.example'});
    assert.equal(crossSite.status,403);
    const badOrigin=await invoke({op:'session'},{origin:'invalid origin'});
    assert.equal(badOrigin.status,400);
    const wrong=await invoke({op:'login',input:{accessKey:'wrong'}});
    assert.equal(wrong.status,401);
    const login=await invoke({op:'login',input:{accessKey:'test-password'}},{origin:'http://localhost:3004'});
    assert.equal(login.status,200); assert.match(login.headers['Set-Cookie'],/HttpOnly; SameSite=Strict/);
    const session=await invoke({op:'session'},{cookie:login.headers['Set-Cookie']});
    assert.equal(session.body.data.authenticated,true);
    assert.equal((await invoke({op:'session'}, {}, 'GET')).status,405);
  } finally {
    if(original===undefined)delete process.env.BATCH_LAB_ACCESS_KEY;else process.env.BATCH_LAB_ACCESS_KEY=original;
  }
});
