import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphClient } from '@jg/sharepoint-core';
import { createConnectionTestPng } from './test-image';

/**
 * Stands in for Graph during a channel lookup.
 *
 * `siteSources` decides which of the three site-id sources answer usefully, so
 * a test can reproduce a tenant that withholds one read while allowing another.
 */
function mockGraph(options: {
  groupSite?: 'ok' | 'forbidden' | 'not-composite';
  driveRoot?: 'ok' | 'no-ids';
  delegated?: boolean;
}) {
  const requested: string[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);

    if (url.includes('/oauth2/v2.0/token')) {
      return Response.json({ access_token: 'test-token', expires_in: 3600 });
    }
    if (url.includes('joinedTeams')) {
      return Response.json({ value: [{ id: 'team-1', displayName: '시공서비스' }] });
    }
    if (url.includes('/teams/team-1/channels?')) {
      return Response.json({ value: [{ id: 'channel-1', displayName: '시공사진' }] });
    }
    if (url.endsWith('/teams/team-1/channels/channel-1/filesFolder')) {
      return Response.json({
        id: 'folder-1',
        name: '시공사진',
        webUrl: 'https://urotech.sharepoint.com/sites/sigong/Shared%20Documents/sigong',
        parentReference: { driveId: 'drive-1' },
      });
    }
    if (url.includes('/groups/team-1/sites/root')) {
      if (options.groupSite === 'forbidden') return new Response('denied', { status: 403 });
      if (options.groupSite === 'not-composite') return Response.json({ id: 'root' });
      return Response.json({
        id: 'urotech.sharepoint.com,64a71b72-1cc1-4d0d-87ae-f173cfa23dfb,0466f0d1-1ec8-430e-b906-8a1f2c3d4e5f',
        webUrl: 'https://urotech.sharepoint.com/sites/sigong',
      });
    }
    if (url.includes('/drives/drive-1/root')) {
      if (options.driveRoot === 'no-ids') {
        return Response.json({ id: 'root-1', webUrl: 'https://urotech.sharepoint.com/sites/sigong' });
      }
      return Response.json({
        id: 'root-1',
        webUrl: 'https://urotech.sharepoint.com/sites/sigong/Shared%20Documents',
        sharepointIds: {
          siteId: '64a71b72-1cc1-4d0d-87ae-f173cfa23dfb',
          webId: '0466f0d1-1ec8-430e-b906-8a1f2c3d4e5f',
          siteUrl: 'https://urotech.sharepoint.com/sites/sigong',
        },
      });
    }
    // A real Graph `drive` carries no sharepointIds — the property belongs to
    // driveItem/site. Answering without it is the point of this stub: the old
    // code read the id from here and could never find it.
    if (url.includes('/drives/drive-1?')) {
      return Response.json({
        id: 'drive-1',
        name: 'Documents',
        webUrl: 'https://urotech.sharepoint.com/sites/sigong/Shared%20Documents',
      });
    }
    if (url.includes('/drives/drive-1/items/folder-1')) {
      return Response.json({ id: 'folder-1', webUrl: 'https://urotech.sharepoint.com/x' });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  return { requested, restore: () => { globalThis.fetch = original; } };
}

const CREDENTIALS = {
  tenantId: 'tenant', clientId: 'client', clientSecret: 'secret', siteId: '', driveId: '',
};
const EXPECTED_SITE_ID =
  'urotech.sharepoint.com,64a71b72-1cc1-4d0d-87ae-f173cfa23dfb,0466f0d1-1ec8-430e-b906-8a1f2c3d4e5f';

test('계정과 Teams 표시 이름으로 채널의 Graph 저장 대상을 찾는다', async () => {
  const graph = mockGraph({});
  try {
    const target = await new GraphClient(CREDENTIALS).resolveTeamsStorageTarget({
      accountEmail: 'admin@urotech.co.kr', teamName: '시공서비스', channelName: '시공사진',
    });
    assert.equal(target.driveId, 'drive-1');
    assert.equal(target.siteId, EXPECTED_SITE_ID);
    assert.equal(target.channelFolder, '시공사진');
    assert.ok(graph.requested.some((url) => url.includes('joinedTeams')));
  } finally {
    graph.restore();
  }
});

test('팀 사이트 조회가 막히면 드라이브 루트 항목에서 사이트 ID를 만든다', async () => {
  // The tenant refuses the group-site read. The drive's *root item* still
  // carries sharepointIds, so the connection has to succeed anyway rather than
  // stopping at the first refusal.
  const graph = mockGraph({ groupSite: 'forbidden' });
  try {
    const target = await new GraphClient(CREDENTIALS).resolveTeamsStorageTarget({
      accountEmail: 'admin@urotech.co.kr', teamName: '시공서비스', channelName: '시공사진',
    });
    assert.equal(target.siteId, EXPECTED_SITE_ID);
    assert.ok(graph.requested.some((url) => url.includes('/drives/drive-1/root')));
  } finally {
    graph.restore();
  }
});

test('사이트 ID를 못 찾으면 시도한 경로를 오류 메시지에 남긴다', async () => {
  const graph = mockGraph({ groupSite: 'forbidden', driveRoot: 'no-ids' });
  try {
    await assert.rejects(
      new GraphClient(CREDENTIALS).resolveTeamsStorageTarget({
        accountEmail: 'admin@urotech.co.kr', teamName: '시공서비스', channelName: '시공사진',
      }),
      // A bare "구성하지 못했습니다" gave the admin nothing to act on.
      (err: Error) => /시도한 경로/.test(err.message) && /403/.test(err.message)
    );
  } finally {
    graph.restore();
  }
});

test('위임 로그인 상태에서는 /me/joinedTeams 로 팀을 찾는다', async () => {
  const graph = mockGraph({});
  try {
    const client = new GraphClient(CREDENTIALS, async () => 'delegated-token');
    const target = await client.resolveTeamsStorageTarget({
      accountEmail: 'admin@urotech.co.kr', teamName: '시공서비스', channelName: '시공사진',
    });
    assert.equal(target.siteId, EXPECTED_SITE_ID);
    assert.ok(graph.requested.some((url) => url.includes('/me/joinedTeams')));
    // The app-only route needs a tenant-wide permission; it must not be used.
    assert.ok(!graph.requested.some((url) => url.includes('/users/')));
    // And no client-credentials token is fetched when a provider supplies one.
    assert.ok(!graph.requested.some((url) => url.includes('/oauth2/v2.0/token')));
  } finally {
    graph.restore();
  }
});

test('테스트 업로드용 데이터는 유효한 PNG 서명과 크기를 가진다', () => {
  const image = createConnectionTestPng();
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(image.length > 100);
});
