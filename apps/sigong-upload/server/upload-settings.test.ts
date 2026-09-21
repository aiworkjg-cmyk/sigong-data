import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SharePointService, DEFAULT_RULE } from '@jg/sharepoint-core';
import { Mailer, type UploadFailureRecord } from './mailer';
import { config } from './config';
import type { WorkOrder } from '../src/types';

test('실제 파일 저장에는 선택한 시공종류의 파일 이름 규칙이 적용된다', async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(),'sigong-rule-'));
 try {
  const source = path.join(root,'photo.jpg'); await fs.writeFile(source, 'test-file');
  const service = new SharePointService({credentials:{tenantId:'',clientId:'',clientSecret:'',siteId:'',driveId:''},rule:{...DEFAULT_RULE,fileNameTemplate:'공통_{번호}'},testModeRoot:path.join(root,'stored')});
  service.ruleForConstructionType = (type) => ({...DEFAULT_RULE,root:'자료',segments:[type],fileNameTemplate:'전용_{종류}_{번호}'});
  const result = await service.syncSubmission({id:'TEST-1',constructionType:'백조',address:'경기 광명시',managerName:'홍길동',constructionDate:'2026-09-10',createdAt:'2026-09-10T00:00:00Z',notes:''},[{id:'file-1',filePath:source,fileName:'photo.jpg',fileType:'image',size:9}]);
  assert.equal(result.failedFiles.length, 0);
  assert.match(result.syncedFiles[0].fileName, /^전용_이미지_001\.jpg$/);
 } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('오류 메일은 설정 수신자를 사용하고 주문 상세와 이스케이프된 오류를 포함한다', async () => {
 const oldMail = {...config.mail}; const oldCredentials = {...config.sharePoint}; const oldFetch = globalThis.fetch;
 try {
  Object.assign(config.mail,{sender:'sender@example.com',alertRecipients:['old@example.com']});
  Object.assign(config.sharePoint,{tenantId:'test',clientId:'test',clientSecret:'test'});
  const mailer = new Mailer(); (mailer as any).client = {getAccessToken:async () => 'mock-token'};
  let sent: any;
  globalThis.fetch = async (_url, init) => { sent = JSON.parse(String(init?.body)); return new Response(null,{status:202}); };
  const record: UploadFailureRecord = {id:'SITE-1',constructionType:'백조',workOrderId:'ORDER-1',address:'경기 광명시 123',managerName:'홍길동',constructionDate:'2026-09-10',createdAt:'2026-09-10T00:00:00Z',status:'FAILED',notes:'',folderPath:'자료',files:[],syncMessage:'저장 실패'};
  const order = {id:'ORDER-1',orderNumber:'PO-123',customerName:'주문자',phone:'010-1111-2222',scheduledDate:'2026-09-11',extras:[{label:'모델',value:'모델-A'}]} as WorkOrder;
  await mailer.notifyUploadFailure(record,['403: <script>오류</script>'],['new@example.com'],order);
  assert.deepEqual(sent.message.toRecipients,[{emailAddress:{address:'new@example.com'}}]);
  for (const value of ['PO-123','주문자','010-1111-2222','2026-09-11','경기 광명시 123','모델-A','&lt;script&gt;']) assert.ok(sent.message.body.content.includes(value),value);
  assert.ok(!sent.message.body.content.includes('<script>'));
  sent = null; await mailer.notifyUploadFailure(record,[],[],order); assert.equal(sent,null);
 } finally { Object.assign(config.mail,oldMail); Object.assign(config.sharePoint,oldCredentials); globalThis.fetch = oldFetch; }
});
