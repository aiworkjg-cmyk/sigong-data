import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_RULE,
  GraphApiError,
  SharePointService,
  loadFolderRuleFromEnv,
  nextSequences,
  type DriveItem,
} from '@jg/sharepoint-core';

const siteFolder = '0826_경기도광명시_이편한세상';
const parentPath = `/drives/test/root:/시공현장자료/백조/2026/08월/${siteFolder}`;

function makeService(items: DriveItem[], existing: DriveItem[], rename: (id: string, name: string) => void) {
  const service = new SharePointService({
    credentials: { tenantId: '', clientId: '', clientSecret: '', siteId: '', driveId: '' },
    rule: DEFAULT_RULE,
    testModeRoot: '.',
  });

  (service as any).client = {
    driveDelta: async () => ({ items, cursor: 'next-cursor' }),
    getItem: async (id: string) => items.find((item) => item.id === id) || null,
    listChildren: async () => existing,
    renameItem: async (id: string, name: string) => {
      rename(id, name);
      return { id, name };
    },
    deltaCursorFrom: (at: Date) => `timestamp:${at.toISOString()}`,
  };

  return service;
}

test('시공종류 전용 파일 이름을 수동 업로드로 오인하여 다시 이름 바꾸지 않는다', async () => {
 const item: DriveItem = {id:'custom',name:'백조_이미지_001.jpg',createdDateTime:'2026-09-10T00:00:00Z',parentReference:{path:parentPath},file:{mimeType:'image/jpeg'}};
 const renamed: string[] = [];
 const service = makeService([item],[],(_id,name) => renamed.push(name));
 service.rulesForManualUploads = () => [{...DEFAULT_RULE,fileNameTemplate:'백조_{종류}_{번호}'}];
 await service.reconcileManualUploads('cursor',new Date('2026-09-01'));
 assert.deepEqual(renamed,[]);
});

test('수동 이미지와 동영상을 기존 순번 다음으로 이름 변경한다', async () => {
  const managed: DriveItem = {
    id: 'managed',
    name: `${siteFolder}_이미지003.jpg`,
    file: {},
    createdDateTime: '2026-08-26T01:00:02Z',
    parentReference: { path: parentPath },
  };
  const metadata: DriveItem = { id: 'metadata', name: '현장정보.json', file: {} };
  const changed: DriveItem[] = [
    {
      id: 'photo',
      name: 'KakaoTalk.jpg',
      file: {},
      eTag: 'photo-etag',
      createdDateTime: '2026-08-26T01:00:00Z',
      parentReference: { path: parentPath },
    },
    {
      id: 'video',
      name: 'clip.mp4',
      file: {},
      eTag: 'video-etag',
      createdDateTime: '2026-08-26T01:00:01Z',
      parentReference: { path: parentPath },
    },
    managed,
  ];
  const renamed: string[] = [];
  const service = makeService(changed, [metadata, managed], (_id, name) => renamed.push(name));

  const result = await service.reconcileManualUploads(
    'cursor',
    new Date('2026-08-26T00:00:00Z')
  );

  assert.deepEqual(renamed, [
    `${siteFolder}_이미지004.jpg`,
    `${siteFolder}_동영상001.mp4`,
  ]);
  assert.deepEqual(
    [result.renamed, result.skipped, result.failed.length, result.nextCursor],
    [2, 1, 0, 'next-cursor']
  );
});

test('앱 생성 표식이 없는 같은 깊이의 폴더는 건드리지 않는다', async () => {
  const changed: DriveItem[] = [
    {
      id: 'unrelated',
      name: 'photo.jpg',
      file: {},
      createdDateTime: '2026-08-26T01:00:00Z',
      parentReference: { path: parentPath },
    },
  ];
  const renamed: string[] = [];
  const service = makeService(changed, [], (_id, name) => renamed.push(name));

  const result = await service.reconcileManualUploads(
    'cursor',
    new Date('2026-08-26T00:00:00Z')
  );

  assert.deepEqual(renamed, []);
  assert.equal(result.skipped, 1);
});

test('기능 활성화 전에 생성된 보관 파일은 이후 수정되어도 이름을 유지한다', async () => {
  const changed: DriveItem[] = [
    {
      id: 'historical',
      name: 'old-photo.jpg',
      file: {},
      createdDateTime: '2026-08-25T01:00:00Z',
      parentReference: { path: parentPath },
    },
  ];
  const renamed: string[] = [];
  const service = makeService(
    changed,
    [{ id: 'metadata', name: '현장정보.json', file: {} }],
    (_id, name) => renamed.push(name)
  );

  const result = await service.reconcileManualUploads(
    'cursor',
    new Date('2026-08-26T00:00:00Z')
  );

  assert.deepEqual(renamed, []);
  assert.equal(result.examined, 0);
});

test('네 자리보다 큰 기존 순번도 다음 번호 계산에 포함한다', () => {
  assert.equal(nextSequences([`${siteFolder}_이미지10000.jpg`]).이미지, 10000);
});

test('관리자가 바꾼 파일명 규칙에서도 기존 순번 다음 번호를 찾는다', () => {
  const template = '{짧은연도}_{지역}_{종류}_{번호}';
  const sequence = nextSequences(
    ['26_경기도광명시_이미지_007.jpg', '26_경기도광명시_동영상_003.mp4'],
    siteFolder,
    template
  );

  assert.deepEqual(sequence, { 이미지: 7, 동영상: 3, 파일: 0 });
});

test('{종류} 없는 파일명 규칙은 모든 유형이 하나의 번호 공간을 쓴다', () => {
  const sequence = nextSequences(
    [`${siteFolder}_012.jpg`],
    siteFolder,
    '{폴더명}_{번호}'
  );

  assert.deepEqual(sequence, { 이미지: 12, 동영상: 12, 파일: 12 });
});

test('Teams 채널 폴더와 업체별 규칙이 포함된 실제 경로도 수동 정리한다', async () => {
  const effectiveRule = {
    ...DEFAULT_RULE,
    root: '시공완료사진/시공현장자료',
  };
  const effectiveParent =
    `/drives/test/root:/시공완료사진/시공현장자료/백조/2026/08월/${siteFolder}`;
  const changed: DriveItem[] = [
    {
      id: 'channel-photo',
      name: 'manual.jpg',
      file: {},
      createdDateTime: '2026-08-26T01:00:00Z',
      parentReference: { path: effectiveParent },
    },
  ];
  const renamed: string[] = [];
  const service = makeService(
    changed,
    [{ id: 'metadata', name: '현장정보.json', file: {} }],
    (_id, name) => renamed.push(name)
  );
  service.rulesForManualUploads = () => [effectiveRule];

  const result = await service.reconcileManualUploads(
    'cursor',
    new Date('2026-08-26T00:00:00Z')
  );

  assert.deepEqual(renamed, [`${siteFolder}_이미지001.jpg`]);
  assert.equal(result.renamed, 1);
});

test('Graph API 오류 상태 코드를 보존한다', () => {
  const error = new GraphApiError('expired', 410, 'gone');
  assert.equal(error.status, 410);
});

test('환경변수의 파일명 규칙도 서비스 규칙으로 읽는다', () => {
  const rule = loadFolderRuleFromEnv({
    SHAREPOINT_FILE_NAME_TEMPLATE: '{짧은연도}_{종류}_{번호}',
  } as NodeJS.ProcessEnv);

  assert.equal(rule.fileNameTemplate, '{짧은연도}_{종류}_{번호}');
});
