import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveFolder } from '@jg/sharepoint-core';
import { SettingsService } from './settings';
import type { SettingsRepository } from './repositories';

class MemorySettings implements SettingsRepository {
  private values = new Map<string, string>([
    ['constructionTypes', JSON.stringify(['백조'])],
  ]);

  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string) { this.values.set(key, value); }
}

test('종류별 파일 이름은 공통 변경 후에도 유지되고 비우면 공통 규칙으로 복귀한다', async () => {
 const repo = new MemorySettings(); const settings = new SettingsService(repo); await settings.load();
 await settings.setFolderRule({root:'자료',segments:['{시공종류}'],fileNameTemplate:'공통_{번호}'});
 await settings.saveFolderRuleAsDefault();
 await settings.setConstructionTypeConfig('백조', {folderRule:{root:'자료',segments:['{시공종류}'],fileNameTemplate:'백조_{종류}_{번호}'}});
 await settings.setFolderRule({root:'새자료',segments:['{시공종류}'],fileNameTemplate:'새공통_{번호}'});
 assert.equal(settings.effectiveFolderRule('백조').fileNameTemplate, '백조_{종류}_{번호}');
 const reloaded = new SettingsService(repo); await reloaded.load();
 assert.equal(reloaded.effectiveFolderRule('백조').fileNameTemplate, '백조_{종류}_{번호}');
 assert.equal(reloaded.folderRuleDefault()?.fileNameTemplate, '공통_{번호}');
 await reloaded.setConstructionTypeConfig('백조', {folderRule:{...reloaded.constructionTypeConfig('백조')!.folderRule,fileNameTemplate:''}});
 assert.equal(reloaded.effectiveFolderRule('백조').fileNameTemplate, '새공통_{번호}');
 await assert.rejects(reloaded.setConstructionTypeConfig('백조', {folderRule:{root:'자료',segments:['{시공종류}'],fileNameTemplate:'중복이름'}}), /번호/);
});

test('시공종류별 필드와 Teams 채널 경로를 한 규칙으로 결합한다', async () => {
  const settings = new SettingsService(new MemorySettings());
  await settings.load();

  const target = await settings.saveStorageTarget({
    id: '',
    teamName: '시공서비스',
    channelName: '시공사진',
    siteId: 'site-id',
    driveId: 'drive-id',
    channelFolder: '시공사진',
  });
  await settings.selectStorageTarget(target.id);
  await settings.setConstructionTypeConfig('백조', {
    constructionType: '백조',
    fields: [
      { id: 'site-type', label: '현장종류', token: 'siteType', inputType: 'select', required: true, options: ['롯데부산점', '현대목동'] },
      { id: 'customer-name', label: '주문자명', token: 'customerName', inputType: 'text', required: true, options: [] },
    ],
    folderRule: {
      root: '',
      segments: ['{type}', '{siteType}', '{customerName}', '{date}_시공완료사진'],
    },
  });

  const rule = settings.effectiveFolderRule('백조');
  const folder = resolveFolder({
    siteId: 'X',
    constructionType: '백조',
    siteType: '롯데부산점',
    customerName: '홍길동',
    constructionDate: '2026-08-27',
    address: '부산광역시',
    managerName: '기사(팀장)',
    submittedAt: '2026-08-27T00:00:00.000Z',
  }, rule);

  assert.equal(
    folder.fullFolderPath,
    '시공사진/백조/롯데부산점/홍길동/2026-08-27_시공완료사진'
  );
  assert.deepEqual(settings.constructionTypeConfig('백조')?.fields[0].options, [
    '롯데부산점', '현대목동',
  ]);
});

test('기존 시공종류는 업그레이드 직후 새 필드 때문에 차단되지 않는다', async () => {
  const settings = new SettingsService(new MemorySettings());
  await settings.load();
  const config = settings.constructionTypeConfig('백조');
  assert.deepEqual(config?.fields, []);
});

test('여러 저장 대상과 Teams 알림을 목록으로 저장하고 전환한다', async () => {
  const settings = new SettingsService(new MemorySettings());
  await settings.load();
  const firstActive = settings.storageTargets().activeTargetId;
  const second = await settings.saveStorageTarget({
    teamName: 'TEST', channelName: '03_시공', siteId: 'site-2', driveId: 'drive-2', channelFolder: '03_시공',
  });
  assert.notEqual(second.id, firstActive);
  assert.equal(settings.storageTargets().targets.length, 2);
  await settings.selectStorageTarget(second.id);
  assert.equal(settings.storageTarget().channelName, '03_시공');

  const firstHook = await settings.saveTeamsWebhook({
    teamName: 'TEST', channelName: '03_시공',
    url: 'https://prod-00.koreacentral.logic.azure.com/workflows/one',
  });
  await settings.saveTeamsWebhook({
    teamName: '시공서비스', channelName: '시공사진',
    url: 'https://prod-01.koreacentral.logic.azure.com/workflows/two',
  });
  assert.equal(settings.teamsWebhooks().length, 2);
  await settings.removeTeamsWebhook(firstHook.id);
  assert.equal(settings.teamsWebhooks()[0].channelName, '시공사진');
});

test('Power Automate 로 발급된 최신 Teams 워크플로 주소도 저장된다', async () => {
  const settings = new SettingsService(new MemorySettings());
  await settings.load();

  // The address Teams issues today. It is not on *.logic.azure.com, which is
  // what the old host rule expected — that mismatch is what let a test card
  // succeed while saving the very same address failed.
  const saved = await settings.saveTeamsWebhook({
    teamName: '시공서비스',
    channelName: '시공사진',
    url: 'https://default1a2b.05.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?api-version=1',
  });
  assert.equal(settings.teamsWebhooks().length, 1);

  // Still a list, and still additive.
  await settings.saveTeamsWebhook({
    teamName: '시공서비스',
    channelName: '02_품질',
    url: 'https://prod-07.koreacentral.logic.azure.com/workflows/def/triggers/manual/paths/invoke',
  });
  assert.equal(settings.teamsWebhooks().length, 2);

  // The same address twice would post the same card twice per submission.
  await assert.rejects(
    settings.saveTeamsWebhook({ teamName: 'X', channelName: 'Y', url: saved.url }),
    /이미 등록된 워크플로 주소/
  );
  // A host that is nobody's Teams webhook is still refused, and says which host.
  await assert.rejects(
    settings.saveTeamsWebhook({ teamName: 'X', channelName: 'Y', url: 'https://example.com/hook' }),
    /example\.com/
  );
});

test('추가 입력 항목의 폴더 토큰은 항목 이름에서 만들어지고 직접 고칠 수 있다', async () => {
  const settings = new SettingsService(new MemorySettings());
  await settings.load();

  const saved = await settings.setConstructionTypeConfig('백조', {
    constructionType: '백조',
    fields: [
      // No token supplied — derived from the label rather than randomised.
      { id: 'f1', label: '주문번호', token: '', inputType: 'text', required: false, options: [] },
      // Token chosen by hand, and kept exactly as written.
      { id: 'f2', label: '현장 담당', token: '담당자', inputType: 'text', required: false, options: [] },
    ],
    folderRule: { root: '', segments: ['{type}', '{주문번호}_{담당자}'] },
  });
  assert.equal(saved.fields[0].token, '주문번호');
  assert.equal(saved.fields[1].token, '담당자');

  // And the folder template actually substitutes them.
  const folder = resolveFolder({
    siteId: 'X',
    constructionType: '백조',
    customFields: [
      { token: '주문번호', value: 'A-1024' },
      { token: '담당자', value: '홍길동' },
    ],
    constructionDate: '2026-08-27',
    address: '부산광역시',
    managerName: '기사(팀장)',
    submittedAt: '2026-08-27T00:00:00.000Z',
  }, settings.effectiveFolderRule('백조'));
  assert.equal(folder.fullFolderPath.endsWith('백조/A-1024_홍길동'), true, folder.fullFolderPath);

  // A built-in name would shadow the value the submission itself supplies.
  await assert.rejects(
    settings.setConstructionTypeConfig('백조', {
      constructionType: '백조',
      fields: [{ id: 'f1', label: '지역', token: 'region', inputType: 'text', required: false, options: [] }],
      folderRule: { root: '', segments: ['{type}'] },
    }),
    /이미 쓰고 있는 폴더 토큰/
  );
});

test('저장 대상을 수정해도 연결할 때 읽어 온 채널 폴더는 그대로 유지된다', async () => {
  const settings = new SettingsService(new MemorySettings());
  await settings.load();

  // As resolved from Graph: the channel is renamed but its folder is not, so
  // the two genuinely differ and the folder is the authoritative one.
  const target = await settings.saveStorageTarget({
    teamName: '시공서비스', channelName: '시공사진',
    siteId: 'site-1', driveId: 'drive-1', channelFolder: '02_시공사진_원본',
  });

  // The 수정 form no longer carries a 채널 폴더 경로 field at all.
  const edited = await settings.saveStorageTarget({
    id: target.id, teamName: '시공서비스', channelName: '시공사진(2026)',
    siteId: 'site-1', driveId: 'drive-1',
  });
  assert.equal(edited.channelFolder, '02_시공사진_원본');
  assert.equal(edited.channelName, '시공사진(2026)');
});
