import { Router } from 'express';
import { SUBMISSION_FIELDS } from '../../src/submission-layout';
import type { Response } from 'express';
import { DelegatedAuthError, GraphApiError, GraphClient } from '@jg/sharepoint-core';
import { AdminError, scopeOf } from '../admin-directory';
import { requireManager, requireMaster } from '../auth';
import { config } from '../config';
import { mailer } from '../mailer';
import { SettingsError, assertTeamsWebhookUrl } from '../settings';
import { buildCard, teams } from '../teams';
import type { AppContext } from '../context';
import { ASSIGNABLE_ROLES } from '../../src/types';
import type {
  AdminSession,
  AssignableRole,
  Issue,
  SiteRecord,
  IssuePriority,
  IssueStatus,
  ViewScope,
} from '../../src/types';
import { cleanText, clientIp, escapeHtml, generateId } from '../util';
import { createConnectionTestPng } from '../test-image';

const ISSUE_STATUSES: IssueStatus[] = ['OPEN', 'IN_PROGRESS', 'RESOLVED'];
const ISSUE_PRIORITIES: IssuePriority[] = ['LOW', 'NORMAL', 'HIGH'];

function parseLimit(value: unknown, fallback = 50): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 1), 200) : fallback;
}

function cursorOf(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Returns the requested role, or undefined when the field was not sent. */
function readRole(value: unknown): AssignableRole | undefined {
  return ASSIGNABLE_ROLES.includes(value as AssignableRole)
    ? (value as AssignableRole)
    : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    : [];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Shown beside the folder-rule editor so the admin need not guess key names. */
/** 파일 이름에 쓸 수 있는 토큰. 폴더 토큰과 달리 이 넷뿐입니다. */
const FILE_NAME_ONLY_TOKENS: { token: string; label: string; sample: string }[] = [
  { token: '{번호}', label: '오름차순 번호 (필수)', sample: '001' },
  { token: '{종류}', label: '이미지 / 동영상 / 파일', sample: '이미지' },
  { token: '{폴더명}', label: '저장 폴더 이름', sample: '0809_경기광명시_이편한세상' },
  { token: '{원본파일명}', label: '기사 휴대폰의 원래 이름', sample: 'KakaoTalk_20260803' },
];

const AVAILABLE_TOKENS: { token: string; label: string; sample: string }[] = [
  // 토큰 이름은 한글입니다. 규칙을 읽는 사람이 무엇이 들어갈지 바로 알아보는
  // 것이 토큰의 목적이고, 이 시스템을 쓰는 사람들은 한국어로 일합니다.
  // 예전 영문 이름({type} 등)도 계속 동작합니다 — 이미 저장된 규칙 때문입니다.
  { token: '{시공종류}', label: '시공종류', sample: '백조' },
  { token: '{현장종류}', label: '현장종류', sample: '롯데부산점' },
  { token: '{주문자명}', label: '주문자명', sample: '홍길동' },
  { token: '{지역}', label: '지역 (시도+시군구)', sample: '경기광명시' },
  { token: '{건물명}', label: '건물·아파트명', sample: '이편한세상' },
  { token: '{읍면동}', label: '읍면동', sample: '소하동' },
  { token: '{연도}', label: '연도', sample: '2026' },
  { token: '{월}', label: '월', sample: '08' },
  { token: '{일}', label: '일', sample: '24' },
  { token: '{월일}', label: '월일', sample: '0824' },
  { token: '{시공일}', label: '시공일', sample: '2026-08-24' },
  { token: '{연월}', label: '연-월', sample: '2026-08' },
  { token: '{연월일}', label: '연월일 (두 자리 연도)', sample: '260809' },
  { token: '{짧은연도}', label: '두 자리 연도', sample: '26' },
  { token: '{분기}', label: '분기', sample: 'Q3' },
  { token: '{시도}', label: '시도', sample: '경기' },
  { token: '{시군구}', label: '시군구', sample: '광명시' },
  { token: '{주소}', label: '입력한 주소 전체', sample: '경기 광명시 …' },
  { token: '{주소압축}', label: '주소(공백 제거)', sample: '경기광명시…' },
  { token: '{현장ID}', label: '현장 ID', sample: 'BAEKJO-20260824-001' },
  { token: '{시공기사}', label: '시공기사', sample: '홍길동(팀장)' },
  { token: '{제출일}', label: '제출일', sample: '2026-08-24' },
];

function readDate(value: unknown): string | undefined {
  return typeof value === 'string' && DATE_PATTERN.test(value) ? value : undefined;
}

/**
 * Combines the account's scope with the filters the user picked.
 *
 * The scope always wins: a 업체 관리자 asking for a 시공종류 outside their remit
 * gets the intersection, which is empty, rather than someone else's data.
 */
/**
 * Strips every trace of the storage backend from a record.
 *
 * Where the files physically live is an operations concern: a 업체 관계자 or a
 * 시공기사 has no use for a SharePoint path, and leaking the library layout to
 * accounts that cannot reach it is needless exposure. Attachments stay viewable
 * because the viewer streams them through /files/:id/content, which resolves the
 * real path server-side.
 */
function redactStorage(site: SiteRecord): SiteRecord {
  return {
    ...site,
    folderPath: '',
    attachmentsFolderPath: '',
    webUrl: undefined,
    syncMessage: undefined,
    files: site.files.map((file) => ({
      ...file,
      remotePath: undefined,
      webUrl: undefined,
    })),
  };
}

/** Whether one record falls inside the caller's scope. */
function canRead(scope: ViewScope, site: SiteRecord): boolean {
  if (scope.all) return true;
  if (scope.technicianId) {
    return (site.technicians || []).some((tech) => tech.id === scope.technicianId);
  }
  return scope.constructionTypes.includes(site.constructionType);
}

function resolveSiteFilter(scope: ViewScope, query: Record<string, unknown>) {
  const requested = readStringArray(
    typeof query.constructionType === 'string' ? [query.constructionType] : query.constructionType
  );

  // An empty array means "match nothing", so it must only ever be produced
  // deliberately — a role whose boundary is not 시공종류 gets undefined instead,
  // otherwise a 시공기사 (who has no company scope) would see zero records.
  let constructionTypes: string[] | undefined;
  if (scope.all || scope.technicianId) {
    constructionTypes = requested.length ? requested : undefined;
  } else {
    constructionTypes = requested.length
      ? scope.constructionTypes.filter((type) => requested.includes(type))
      : scope.constructionTypes;
  }

  // A technician only ever sees their own; a wider role may filter by one.
  const technicianId =
    scope.technicianId ??
    (typeof query.technicianId === 'string' && query.technicianId ? query.technicianId : undefined);

  return {
    constructionTypes,
    technicianId,
    from: readDate(query.from),
    to: readDate(query.to),
  };
}

export function createAdminRouter(ctx: AppContext): Router {
  const router = Router();

  /* ---------------------------------------------------------------- */
  /* Diagnostics                                                       */
  /* ---------------------------------------------------------------- */

  router.get('/diagnostics', requireMaster, async (_req, res) => {
    const sharePoint = ctx.sharePoint.getConfigStatus();
    // Only probe live credentials; test mode has nothing to reach.
    const connectivity = sharePoint.isLiveConfigured ? await ctx.sharePoint.probe() : null;

    res.json({
      sharePoint,
      connectivity,
      recordBackend: ctx.repos.backend,
      constructionTypes: ctx.settings.constructionTypes(),
      mail: {
        configured: mailer.isConfigured(),
        sender: config.mail.sender,
        recipients: config.mail.alertRecipients,
      },
      warnings: ctx.warnings,
    });
  });

  router.get('/folders', requireMaster, async (req, res) => {
    try {
      const folderPath = typeof req.query.path === 'string' ? req.query.path : '';
      const entries = await ctx.sharePoint.listFolder(
        folderPath || ctx.sharePoint.getConfigStatus().rootFolder
      );
      res.json({ path: folderPath, entries });
    } catch (err: any) {
      res.status(502).json({ error: '폴더 조회 실패', message: err?.message || String(err) });
    }
  });

  /* ---------------------------------------------------------------- */
  /* 시공현황 리스트 — every signed-in role, narrowed to its own scope    */
  /* ---------------------------------------------------------------- */

  /**
   * The list behind the 시공현황 리스트 screen.
   *
   * Unlike /sites (master-only, the full console) this is reachable by every
   * signed-in account and is always narrowed by the caller's scope, resolved
   * server-side from the stored account.
   */
  router.get('/history', async (req, res) => {
    try {
      const scope = scopeOf(req.admin!);
      const filter = resolveSiteFilter(scope, req.query as Record<string, unknown>);

      // A 업체 관리자 with no 시공종류 assigned yet has no boundary to apply, so
      // answer empty rather than unfiltered — and say why, so the screen can
      // tell them to ask the master instead of showing a bare empty list.
      if (!scope.all && !scope.technicianId && scope.constructionTypes.length === 0) {
        res.json({ items: [], scope, needsScope: true });
        return;
      }

      const page = await ctx.repos.sites.list({
        ...filter,
        limit: parseLimit(req.query.limit, 100),
        cursor: cursorOf(req.query.cursor),
      });

      // Only the master ever sees storage internals.
      const items = scope.all ? page.items : page.items.map(redactStorage);
      res.json({ ...page, items, scope });
    } catch (err: any) {
      res.status(500).json({ error: '시공현황 조회 실패', message: err?.message });
    }
  });

  /** Options for the 시공현황 필터 — only what this account may narrow by. */
  router.get('/history/filters', (req, res) => {
    const scope = scopeOf(req.admin!);
    res.json({
      constructionTypes: scope.all ? ctx.settings.constructionTypes() : scope.constructionTypes,
      technicians: scope.technicianId ? [] : ctx.settings.visibleTechnicians(scope),
      scope,
    });
  });

  /* ---------------------------------------------------------------- */
  /* Sites — full console, master only                                 */
  /* ---------------------------------------------------------------- */

  router.get('/sites', requireMaster, async (req, res) => {
    try {
      const page = await ctx.repos.sites.list({
        limit: parseLimit(req.query.limit),
        cursor: cursorOf(req.query.cursor),
      });
      res.json(page);
    } catch (err: any) {
      res.status(500).json({ error: '현장 목록 조회 실패', message: err?.message });
    }
  });

  /**
   * One record. Reachable by every signed-in role but scope-checked, so the
   * 시공현황 리스트 can open a submission without exposing another company's.
   * A record outside the scope answers 404, not 403 — knowing that an id exists
   * is itself information the caller is not entitled to.
   */
  router.get('/sites/:id', async (req, res) => {
    const scope = scopeOf(req.admin!);
    const site = await ctx.repos.sites.get(req.params.id);
    if (!site || !canRead(scope, site)) {
      res.status(404).json({ error: '현장을 찾을 수 없습니다.' });
      return;
    }
    res.json({ site: scope.all ? site : redactStorage(site) });
  });

  /**
   * Queues another filing attempt. Returns straight away — progress shows up in
   * the record's status, the same path an automatic retry takes.
   */
  router.post('/sites/:id/retry', requireMaster, async (req, res) => {
    const site = await ctx.repos.sites.get(req.params.id);
    if (!site) {
      res.status(404).json({ error: '현장을 찾을 수 없습니다.' });
      return;
    }

    // Reset the counter so a manual retry gets a fresh set of attempts.
    site.attempts = 0;
    site.status = 'QUEUED';
    site.syncMessage = '재시도 요청됨. 순서를 기다리는 중입니다.';
    await ctx.repos.sites.save(site);

    ctx.worker.enqueue({
      siteId: site.id,
      clientIp: clientIp(req),
      userAgent: String(req.headers['user-agent'] || ''),
    });

    res.json({ site });
  });

  /** Streams one attachment back from SharePoint (or the test library). */
  router.get('/sites/:siteId/files/:fileId/content', async (req, res) => {
    const site = await ctx.repos.sites.get(req.params.siteId);
    const file = site?.files.find((candidate) => candidate.id === req.params.fileId);

    if (site && !canRead(scopeOf(req.admin!), site)) {
      res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
      return;
    }
    if (!site || !file || !file.remotePath) {
      res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
      return;
    }

    try {
      const opened = await ctx.sharePoint.openFile(file.remotePath);
      if (!opened) {
        res.status(404).json({ error: '저장소에서 파일을 찾을 수 없습니다.' });
        return;
      }

      res.setHeader('Content-Type', opened.contentType || file.mimeType);
      if (opened.size) res.setHeader('Content-Length', String(opened.size));
      // Attachment names can contain non-ASCII, so use the RFC 5987 form.
      res.setHeader(
        'Content-Disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(file.originalName)}`
      );
      res.setHeader('Cache-Control', 'private, max-age=300');

      opened.stream.pipe(res);
      opened.stream.on('error', (err) => {
        console.error('[admin] 파일 스트리밍 실패', err);
        res.destroy();
      });
    } catch (err: any) {
      res.status(502).json({ error: '파일 조회 실패', message: err?.message || String(err) });
    }
  });

  /* ---------------------------------------------------------------- */
  /* Upload logs                                                       */
  /* ---------------------------------------------------------------- */

  router.get('/logs', requireMaster, async (req, res) => {
    try {
      const result = typeof req.query.result === 'string' ? req.query.result : undefined;
      const page = await ctx.repos.logs.list({
        limit: parseLimit(req.query.limit),
        cursor: cursorOf(req.query.cursor),
        siteId: typeof req.query.siteId === 'string' ? req.query.siteId : undefined,
        result:
          result === 'SUCCESS' || result === 'PARTIAL' || result === 'FAILED' ? result : undefined,
      });
      res.json(page);
    } catch (err: any) {
      res.status(500).json({ error: '업로드 로그 조회 실패', message: err?.message });
    }
  });

  router.get('/logs/summary', requireMaster, async (req, res) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
      res.json(await ctx.repos.logs.summary(days));
    } catch (err: any) {
      res.status(500).json({ error: '통계 조회 실패', message: err?.message });
    }
  });

  /* ---------------------------------------------------------------- */
  /* Issues                                                            */
  /* ---------------------------------------------------------------- */

  router.get('/issues', requireMaster, async (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const page = await ctx.repos.issues.list({
        limit: parseLimit(req.query.limit),
        cursor: cursorOf(req.query.cursor),
        siteId: typeof req.query.siteId === 'string' ? req.query.siteId : undefined,
        status: ISSUE_STATUSES.includes(status as IssueStatus) ? (status as IssueStatus) : undefined,
      });
      res.json(page);
    } catch (err: any) {
      res.status(500).json({ error: '이슈 목록 조회 실패', message: err?.message });
    }
  });

  router.post('/issues', requireMaster, async (req, res) => {
    const title = cleanText(req.body?.title, 200);
    if (!title) {
      res.status(400).json({ error: '입력 오류', message: '이슈 제목을 입력해 주세요.' });
      return;
    }

    const now = new Date().toISOString();
    const priority = req.body?.priority;
    const issue: Issue = {
      id: generateId('issue'),
      createdAt: now,
      updatedAt: now,
      siteId: cleanText(req.body?.siteId, 40) || undefined,
      title,
      body: cleanText(req.body?.body, 5000),
      status: 'OPEN',
      priority: ISSUE_PRIORITIES.includes(priority) ? priority : 'NORMAL',
      author: req.admin?.displayName || '관리자',
      comments: [],
    };

    await ctx.repos.issues.save(issue);
    res.status(201).json({ issue });
  });

  router.patch('/issues/:id', requireMaster, async (req, res) => {
    const issue = await ctx.repos.issues.get(req.params.id);
    if (!issue) {
      res.status(404).json({ error: '이슈를 찾을 수 없습니다.' });
      return;
    }

    const { status, priority } = req.body ?? {};
    if (ISSUE_STATUSES.includes(status)) issue.status = status;
    if (ISSUE_PRIORITIES.includes(priority)) issue.priority = priority;
    if (typeof req.body?.title === 'string') issue.title = cleanText(req.body.title, 200) || issue.title;
    if (typeof req.body?.body === 'string') issue.body = cleanText(req.body.body, 5000);
    issue.updatedAt = new Date().toISOString();

    await ctx.repos.issues.save(issue);
    res.json({ issue });
  });

  router.post('/issues/:id/comments', requireMaster, async (req, res) => {
    const issue = await ctx.repos.issues.get(req.params.id);
    if (!issue) {
      res.status(404).json({ error: '이슈를 찾을 수 없습니다.' });
      return;
    }

    const body = cleanText(req.body?.body, 3000);
    if (!body) {
      res.status(400).json({ error: '입력 오류', message: '내용을 입력해 주세요.' });
      return;
    }

    issue.comments.push({
      id: generateId('comment'),
      at: new Date().toISOString(),
      author: req.admin?.displayName || '관리자',
      body,
    });
    issue.updatedAt = new Date().toISOString();

    await ctx.repos.issues.save(issue);
    res.status(201).json({ issue });
  });

  router.delete('/issues/:id', requireMaster, async (req, res) => {
    await ctx.repos.issues.remove(req.params.id);
    res.json({ success: true });
  });

  /* ---------------------------------------------------------------- */
  /* Settings — 시공종류                                                */
  /* ---------------------------------------------------------------- */

  const handleSettingsError = (err: unknown, res: Response) => {
    if (err instanceof SettingsError) {
      res.status(err.status).json({ error: '설정 오류', message: err.message });
      return;
    }
    console.error('[admin] 설정 변경 실패', err);
    res.status(500).json({ error: '설정 변경 실패', message: '요청을 처리하지 못했습니다.' });
  };

  const handleGraphConnectionError = (
    err: unknown,
    res: Response,
    operation: 'resolve' | 'upload' = 'resolve'
  ) => {
    if (err instanceof SettingsError) {
      handleSettingsError(err, res);
      return;
    }
    if (err instanceof DelegatedAuthError) {
      res.status(err.status >= 400 && err.status < 500 ? err.status : 502).json({
        error: 'Microsoft 로그인 오류',
        message: err.message,
      });
      return;
    }
    if (err instanceof GraphApiError) {
      const message = err.status === 403
        ? operation === 'upload'
          ? '대상 SharePoint에 쓰기 권한이 없습니다. Sites.Selected를 사용한다면 이 사이트에 앱의 write 권한을 부여하고, 전체 자동 연결 방식을 사용한다면 Files.ReadWrite.All 관리자 동의를 확인해 주세요.'
          // The delegated route is named first because it is the one an admin
          // can act on alone: signing in as themselves needs no tenant-wide
          // application permission, which is what usually blocks this call.
          : 'Teams 조회 권한이 없습니다. 설정 화면에서 [Microsoft 로그인]으로 업무 계정을 연결하면 관리자 동의 없이 본인이 속한 팀을 찾을 수 있습니다. 앱 권한 방식으로 쓰려면 Azure 앱에 Team.ReadBasic.All, Channel.ReadBasic.All, Files.ReadWrite.All 응용 프로그램 권한과 관리자 동의가 필요합니다.'
        : err.status === 401
          ? 'Azure 앱 인증에 실패했습니다. 테넌트 ID, 클라이언트 ID, 클라이언트 암호를 확인해 주세요.'
          : err.message;
      res.status(err.status >= 400 && err.status < 500 ? err.status : 502).json({
        error: 'Microsoft 365 연결 실패',
        message,
      });
      return;
    }
    console.error('[admin] Microsoft 365 연결 실패', err);
    res.status(502).json({
      error: 'Microsoft 365 연결 실패',
      message: err instanceof Error ? err.message : '요청을 처리하지 못했습니다.',
    });
  };

  /**
   * 앱을 거치지 않은 SharePoint 변경 기록.
   *
   * 업로드 로그와 분리돼 있습니다 — 업로드 로그는 이 사이트를 통한 실제
   * 업로드만 담고, 사람이 SharePoint 를 직접 만진 사건은 이쪽에 쌓입니다.
   */
  router.get('/manual-audit', requireMaster, async (req, res) => {
    const { readManualAudit } = await import('../manual-audit');
    const limit = Math.min(Math.max(Number(req.query?.limit) || 500, 1), 5000);
    res.json({ entries: await readManualAudit(limit) });
  });

  router.get('/settings/construction-types', (_req, res) => {
    res.json({ constructionTypes: ctx.settings.constructionTypes() });
  });

  router.post('/settings/construction-types', requireMaster, async (req, res) => {
    try {
      const constructionTypes = await ctx.settings.addConstructionType(
        cleanText(req.body?.name, 40)
      );
      res.status(201).json({ constructionTypes });
    } catch (err) {
      handleSettingsError(err, res);
    }
  });

  /**
   * Removes a type from the selectable list. Submissions already filed under it
   * keep their folder — this only stops the value being offered from now on.
   */
  router.delete('/settings/construction-types/:name', requireMaster, async (req, res) => {
    try {
      const constructionTypes = await ctx.settings.removeConstructionType(req.params.name);
      res.json({ constructionTypes });
    } catch (err) {
      handleSettingsError(err, res);
    }
  });

  /* ---------------------------------------------------------------- */
  /* 시공기사 명부                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * The roster, narrowed to what this account may see.
   *
   * A 시공기사 gets only their own entry: they never manage the roster, and the
   * filter list on 시공현황 is empty for them anyway.
   */
  const rosterFor = (admin: AdminSession) => {
    const scope = scopeOf(admin);
    if (scope.technicianId) {
      const own = ctx.settings.findTechnician(scope.technicianId);
      return own ? [own] : [];
    }
    return ctx.settings.visibleTechnicians(scope);
  };

  router.get('/technicians', (req, res) => {
    res.json({
      technicians: rosterFor(req.admin!),
      // The 업체 a manager may tag someone with — never wider than their own.
      assignableTypes: scopeOf(req.admin!).all
        ? ctx.settings.constructionTypes()
        : req.admin!.constructionTypes,
      deleteRequestEmails: ctx.settings.deleteRequestEmails(),
    });
  });

  /**
   * Keeps a 업체 관리자 inside its own lane.
   *
   * Tags outside the actor's scope are preserved untouched — a master may have
   * put someone in two companies, and 백조 editing them must not quietly drop
   * 한샘 — while the tags inside the scope become exactly what was requested.
   */
  function resolveTechnicianTypes(
    admin: AdminSession,
    requested: string[],
    existing: string[]
  ): string[] {
    if (scopeOf(admin).all) return requested;

    const own = admin.constructionTypes;
    const untouched = existing.filter((type) => !own.includes(type));
    const mine = requested.filter((type) => own.includes(type));
    return [...new Set([...untouched, ...mine])];
  }

  router.post('/technicians', requireManager, async (req, res) => {
    try {
      const admin = req.admin!;
      const requested = readStringArray(req.body?.constructionTypes);
      // A 업체 관리자 adding nobody's-company would immediately lose sight of
      // the person they just created, so default them to their own 업체.
      const constructionTypes = scopeOf(admin).all
        ? requested
        : resolveTechnicianTypes(admin, requested, []).length > 0
          ? resolveTechnicianTypes(admin, requested, [])
          : admin.constructionTypes;

      const technician = await ctx.settings.addTechnician({
        name: cleanText(req.body?.name, 40),
        title: String(req.body?.title || ''),
        constructionTypes,
        phone: cleanText(req.body?.phone, 20),
        region: cleanText(req.body?.region, 40),
        createdBy: admin.username,
      });
      res.status(201).json({ technician, technicians: rosterFor(admin) });
    } catch (err) {
      handleSettingsError(err, res);
    }
  });

  router.patch('/technicians/:id', requireManager, async (req, res) => {
    try {
      const admin = req.admin!;
      const existing = ctx.settings.findTechnician(req.params.id);
      if (!existing || !rosterFor(admin).some((tech) => tech.id === existing.id)) {
        res.status(404).json({ error: '등록되지 않은 시공기사입니다.' });
        return;
      }

      const technician = await ctx.settings.updateTechnician(req.params.id, {
        name: typeof req.body?.name === 'string' ? cleanText(req.body.name, 40) : undefined,
        title: typeof req.body?.title === 'string' ? req.body.title : undefined,
        constructionTypes: Array.isArray(req.body?.constructionTypes)
          ? resolveTechnicianTypes(
              admin,
              readStringArray(req.body.constructionTypes),
              existing.constructionTypes
            )
          : undefined,
        phone: typeof req.body?.phone === 'string' ? cleanText(req.body.phone, 20) : undefined,
        region: typeof req.body?.region === 'string' ? cleanText(req.body.region, 40) : undefined,
      });
      res.json({ technician, technicians: rosterFor(admin) });
    } catch (err) {
      handleSettingsError(err, res);
    }
  });

  /**
   * Master only. A 업체 관리자 hitting this gets 403 with the address to write
   * to, which is what the client turns into the "삭제 요청" popup.
   */
  router.delete('/technicians/:id', requireMaster, async (req, res) => {
    try {
      // Deleting the roster entry would orphan any account linked to it.
      if (await ctx.directory.isTechnicianLinked(req.params.id)) {
        res.status(409).json({
          error: '삭제 불가',
          message: '이 기사에 연결된 로그인 계정이 있습니다. 계정을 먼저 삭제해 주세요.',
        });
        return;
      }

      await ctx.settings.removeTechnician(req.params.id);
      res.json({ technicians: rosterFor(req.admin!) });
    } catch (err) {
      handleSettingsError(err, res);
    }
  });

  /* ---------------------------------------------------------------- */
  /* 삭제 요청 수신 메일 (master only)                                   */
  /* ---------------------------------------------------------------- */

  router.get('/settings/delete-request-emails', requireMaster, (_req, res) => {
    res.json({ deleteRequestEmails: ctx.settings.deleteRequestEmails() });
  });

  router.post('/settings/delete-request-emails', requireMaster, async (req, res) => {
    try {
      const deleteRequestEmails = await ctx.settings.addDeleteRequestEmail(
        String(req.body?.email ?? '')
      );
      res.status(201).json({ deleteRequestEmails });
    } catch (err) {
      handleSettingsError(err, res);
    }
  });

  router.patch('/settings/delete-request-emails/:email', requireMaster, async (req, res) => {
    try {
      const deleteRequestEmails = await ctx.settings.updateDeleteRequestEmail(
        req.params.email,
        String(req.body?.email ?? '')
      );
      res.json({ deleteRequestEmails });
    } catch (err) {
      handleSettingsError(err, res);
    }
  });

  router.delete('/settings/delete-request-emails/:email', requireMaster, async (req, res) => {
    try {
      const deleteRequestEmails = await ctx.settings.removeDeleteRequestEmail(req.params.email);
      res.json({ deleteRequestEmails });
    } catch (err) {
      handleSettingsError(err, res);
    }
  });

  /* ---------------------------------------------------------------- */
  /* Teams 알림 (master only)                                          */
  /* ---------------------------------------------------------------- */

  router.get('/settings/teams-webhook', requireMaster, (_req, res) => {
    res.json({ webhooks: ctx.settings.teamsWebhooks() });
  });

  router.post('/settings/teams-webhook', requireMaster, async (req, res) => {
    try {
      const webhook = await ctx.settings.saveTeamsWebhook(req.body || {});
      res.status(201).json({ webhook, webhooks: ctx.settings.teamsWebhooks() });
    } catch (err) {
      handleSettingsError(err, res);
    }
  });

  router.put('/settings/teams-webhook/:id', requireMaster, async (req, res) => {
    try {
      const webhook = await ctx.settings.saveTeamsWebhook({ ...req.body, id: req.params.id });
      res.json({ webhook, webhooks: ctx.settings.teamsWebhooks() });
    } catch (err) { handleSettingsError(err, res); }
  });

  router.delete('/settings/teams-webhook/:id', requireMaster, async (req, res) => {
    try {
      await ctx.settings.removeTeamsWebhook(req.params.id);
      res.json({ webhooks: ctx.settings.teamsWebhooks() });
    } catch (err) { handleSettingsError(err, res); }
  });

  /**
   * Sends one sample card.
   *
   * Worth its own button: the alternative is filing a real submission to find
   * out the address was wrong, and a webhook that silently fails is
   * indistinguishable from one that was never called.
   */
  router.post('/settings/teams-webhook/test', requireMaster, async (req, res) => {
    const url = String(req.body?.url ?? '').trim() || ctx.settings.teamsWebhookUrl();
    if (!url) {
      res.status(400).json({ error: '설정 오류', message: '알림 주소를 먼저 입력해 주세요.' });
      return;
    }
    // The same check the save path runs. When these two disagreed, a test could
    // succeed against an address that could never be saved — which is precisely
    // the state that produced a green "보냈습니다" beside a red save error.
    try {
      assertTeamsWebhookUrl(url);
    } catch (err) {
      handleSettingsError(err, res);
      return;
    }

    // The sample card carries a real folder link so the [자료 폴더 열기] button
    // appears — a test that silently omits the one interactive part of the card
    // proves less than it looks like it does.
    const probe = ctx.sharePoint.getConfigStatus().isLiveConfigured
      ? await ctx.sharePoint.probe()
      : null;

    const sample = {
      id: 'BAEKJO-20260826-001',
      constructionType: ctx.settings.constructionTypes()[0] || '백조',
      technicians: [{ id: 'sample', name: '홍길동', title: '팀장' as const }],
      managerName: '홍길동(팀장)',
      address: '경기도 광명시 소하동 이편한세상 107동 1402호',
      constructionDate: new Date().toISOString().slice(0, 10),
      notes: '알림 연결 확인용 예시입니다. 실제 제출 기록이 아닙니다.',
      createdAt: new Date().toISOString(),
      status: 'COMPLETED' as const,
      storageMode: 'LIVE' as const,
      folderPath: ctx.sharePoint.getConfigStatus().examplePath,
      attachmentsFolderPath: '',
      files: [
        { id: 'f1', originalName: '현장사진.jpg', storedName: '01_현장사진.jpg',
          fileType: 'image' as const, mimeType: 'image/jpeg', size: 0, sizeFormatted: '0 B',
          status: 'completed' as const },
      ],
    };

    const result = await teams.post(url, buildCard(sample, probe?.webUrl));
    if (!result.ok) {
      res.status(502).json({
        error: '알림 전송 실패',
        message: result.error || '알 수 없는 오류',
        status: result.status,
      });
      return;
    }
    res.json({ success: true });
  });

  /* ---------------------------------------------------------------- */
  /* 폴더 생성 규칙 (master only)                                       */
  /* ---------------------------------------------------------------- */

  router.get('/settings/folder-rule', requireMaster, (_req, res) => {
    const rule = ctx.settings.folderRule();
    res.json({
      folderRule: {
        root: rule.root,
        segments: rule.segments,
        fileNameTemplate: rule.fileNameTemplate,
      },
      // 파일 이름에는 폴더 토큰도 그대로 쓸 수 있습니다 — 폴더 이름만으로는
      // 업체가 다른 같은 이름의 폴더를 구분하지 못합니다.
      fileNameTokens: [...FILE_NAME_ONLY_TOKENS, ...AVAILABLE_TOKENS],
      // Rendered from a fixed sample so the admin sees the shape of the result
      // before saving, not after the next submission lands in the wrong place.
      example: ctx.sharePoint.getConfigStatus().examplePath,
      availableTokens: AVAILABLE_TOKENS,
      // 관리자가 저장해 둔 기본값. 없으면 null 이고, 화면은 그때 버튼을 숨깁니다.
      savedDefault: ctx.settings.folderRuleDefault(),
    });
  });

  /**
   * 지금 설정을 기본값으로 저장합니다.
   *
   * 지금 쓰는 규칙과 따로 보관합니다 — 운영 중에 규칙을 이리저리 바꿔 보다가
   * 되돌리고 싶을 때, 코드에 박힌 초기값이 아니라 이 회사가 정한 값으로
   * 돌아가야 의미가 있습니다.
   */
  router.post('/settings/folder-rule/default', requireMaster, async (_req, res) => {
    try {
      await ctx.settings.saveFolderRuleAsDefault();
      res.json({ savedDefault: ctx.settings.folderRuleDefault() });
    } catch (err) {
      handleSettingsError(err, res);
    }
  });

  router.put('/settings/folder-rule', requireMaster, async (req, res) => {
    try {
      const folderRule = await ctx.settings.setFolderRule({
        root: String(req.body?.root ?? ''),
        segments: readStringArray(req.body?.segments),
        fileNameTemplate: req.body?.fileNameTemplate,
      });

      // The service resolves paths from its own copy, so hand it the new rule
      // immediately — otherwise the change would only apply after a restart.
      ctx.sharePoint.rule = folderRule;

      res.json({
        folderRule: {
          root: folderRule.root,
          segments: folderRule.segments,
          fileNameTemplate: folderRule.fileNameTemplate,
        },
        example: ctx.sharePoint.getConfigStatus().examplePath,
      });
    } catch (err) {
      handleSettingsError(err, res);
    }
  });

  /* 자료 업로드 화면의 입력 항목 차례 */

  router.get('/settings/submission-order', requireMaster, (_req, res) => {
    res.json({ orders: ctx.settings.submissionOrders(), fields: SUBMISSION_FIELDS });
  });

  router.put('/settings/submission-order', requireMaster, async (req, res) => {
    try {
      const order = await ctx.settings.setSubmissionOrder(
        String(req.body?.constructionType ?? ''),
        req.body?.order
      );
      res.json({ order });
    } catch (err) {
      handleSettingsError(err, res);
    }
  });

  router.get('/settings/construction-type-configs', requireMaster, (_req, res) => {
    res.json({ configs: ctx.settings.constructionTypeConfigs(), availableTokens: AVAILABLE_TOKENS });
  });

  router.put('/settings/construction-type-configs/:name', requireMaster, async (req, res) => {
    try {
      const configValue = await ctx.settings.setConstructionTypeConfig(
        req.params.name,
        req.body || {}
      );
      res.json({ config: configValue });
    } catch (err) {
      handleSettingsError(err, res);
    }
  });

  /* ---------------------------------------------------------------- */
  /* Microsoft 업무 계정 로그인 (master only)                            */
  /* ---------------------------------------------------------------- */

  router.get('/settings/microsoft', requireMaster, (_req, res) => {
    res.json(ctx.microsoft.view());
  });

  /**
   * Hands back the Microsoft sign-in URL for the admin's browser to open.
   *
   * Returned as a URL rather than served as a redirect because the caller is a
   * fetch() from the 설정 화면: a 302 would be followed by the fetch itself and
   * the admin would never see the Microsoft page.
   */
  router.post('/settings/microsoft/signin', requireMaster, (_req, res) => {
    try {
      const { url } = ctx.microsoft.beginSignIn();
      res.json({ url, redirectUri: ctx.microsoft.redirectUri });
    } catch (err) {
      handleGraphConnectionError(err, res, 'resolve');
    }
  });

  /**
   * Where Microsoft sends the browser back to.
   *
   * Answers with a small HTML page rather than JSON: this is a top-level
   * navigation in a popup the admin is looking at, so it has to say something
   * human and then close itself.
   */
  router.get('/settings/microsoft/callback', requireMaster, async (req, res) => {
    const done = (ok: boolean, message: string) => {
      res.status(ok ? 200 : 400).type('html').send(
        `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>Microsoft 연결</title></head>
<body style="font-family:system-ui,sans-serif;padding:32px;text-align:center">
<h2 style="color:${ok ? '#047857' : '#b91c1c'}">${ok ? '연결되었습니다' : '연결하지 못했습니다'}</h2>
<p style="color:#475569;font-size:14px;max-width:520px;margin:12px auto">${escapeHtml(message)}</p>
<p style="color:#94a3b8;font-size:12px">이 창은 잠시 후 자동으로 닫힙니다.</p>
<script>
  try { window.opener && window.opener.postMessage(
    { source: 'sigong-microsoft', ok: ${ok ? 'true' : 'false'} }, window.location.origin); } catch (e) {}
  setTimeout(function () { window.close(); }, ${ok ? 1200 : 6000});
</script></body></html>`
      );
    };

    // Microsoft reports a refused consent by redirecting here with an error
    // rather than by failing the request, so it has to be read off the query.
    const failure = cleanText(req.query?.error_description, 400) || cleanText(req.query?.error, 200);
    if (failure) {
      done(false, failure);
      return;
    }
    try {
      await ctx.microsoft.completeSignIn(
        cleanText(req.query?.code, 4000),
        cleanText(req.query?.state, 200)
      );
      done(true, `${ctx.microsoft.signedInUpn()} 계정으로 연결되었습니다. 설정 화면으로 돌아가 주세요.`);
    } catch (err) {
      console.error('[admin] Microsoft 로그인 실패', err);
      done(false, err instanceof Error ? err.message : 'Microsoft 로그인에 실패했습니다.');
    }
  });

  router.delete('/settings/microsoft', requireMaster, async (_req, res) => {
    await ctx.microsoft.signOut();
    res.json(ctx.microsoft.view());
  });

  /**
   * The teams and channels the remembered account can actually see.
   *
   * Offered so the admin picks a name instead of typing one. Most "찾지 못했습니다"
   * reports were a spelling difference between the name shown in the Teams
   * sidebar and the team's stored displayName, which no error message can fix
   * as well as simply showing the real list.
   */
  router.get('/settings/microsoft/teams', requireMaster, async (req, res) => {
    try {
      const client = graphClientForLookup();
      const accountEmail = cleanText(req.query?.accountEmail, 254) || ctx.microsoft.signedInUpn();
      const teamId = cleanText(req.query?.teamId, 200);
      if (teamId) {
        const channels = await client.listTeamChannels(teamId);
        res.json({ channels: channels.map(({ id, displayName, membershipType }) =>
          ({ id, displayName, membershipType })) });
        return;
      }
      const joined = await client.listJoinedTeams(accountEmail);
      res.json({ teams: joined.map(({ id, displayName }) => ({ id, displayName })) });
    } catch (err) {
      handleGraphConnectionError(err, res, 'resolve');
    }
  });

  router.get('/settings/storage-target', requireMaster, (_req, res) => {
    res.json(ctx.settings.storageTargets());
  });

  /**
   * A Graph client for read-only Teams lookups.
   *
   * Prefers the signed-in administrator: delegated access needs no tenant-wide
   * consent and sees exactly the teams that person belongs to. Falls back to
   * the app's own credentials for tenants that did grant the application
   * permissions, so existing installations keep working untouched.
   */
  function graphClientForLookup(): GraphClient {
    const credentials = config.sharePoint;
    const delegated = ctx.microsoft.graphClient(credentials);
    if (delegated) return delegated;

    if (!credentials.tenantId || !credentials.clientId || !credentials.clientSecret) {
      throw new SettingsError(
        '서버의 Azure 앱 설정이 없습니다. SHAREPOINT_TENANT_ID, SHAREPOINT_CLIENT_ID, SHAREPOINT_CLIENT_SECRET을 먼저 등록해 주세요.'
      );
    }
    return new GraphClient(credentials);
  }

  router.post('/settings/storage-target/resolve', requireMaster, async (req, res) => {
    try {
      // With an account remembered, the admin supplies a team and a channel and
      // nothing else — which is the whole point of remembering it.
      const accountEmail =
        cleanText(req.body?.accountEmail, 254) || ctx.microsoft.signedInUpn();
      const teamName = cleanText(req.body?.teamName, 80);
      const channelName = cleanText(req.body?.channelName, 80);
      if (!teamName || !channelName) {
        throw new SettingsError('Teams 팀 이름과 채널 이름을 입력해 주세요.');
      }
      const client = graphClientForLookup();
      // Only the app-only path needs to be told whose teams to read; a delegated
      // token already carries the account.
      if (!client.isDelegated && (!accountEmail || !accountEmail.includes('@'))) {
        throw new SettingsError(
          'Microsoft 업무 계정을 확인할 수 없습니다. [Microsoft 로그인]으로 계정을 연결하거나 계정 이메일을 입력해 주세요.'
        );
      }

      const resolved = await client.resolveTeamsStorageTarget({
        accountEmail,
        teamName,
        channelName,
      });
      const existing = ctx.settings.storageTargets().targets.find((entry) =>
        (entry.channelId && entry.channelId === resolved.channelId) ||
        (entry.driveId === resolved.driveId && entry.channelFolder === resolved.channelFolder)
      );
      const target = await ctx.settings.saveStorageTarget({ ...resolved, id: existing?.id });
      await ctx.settings.selectStorageTarget(target.id);
      ctx.sharePoint.setStorageTarget({ siteId: target.siteId, driveId: target.driveId });
      await ctx.manualUploads.resetForTarget();
      res.status(201).json({
        target,
        ...ctx.settings.storageTargets(),
        status: ctx.sharePoint.getConfigStatus(),
        channelWebUrl: resolved.webUrl,
      });
    } catch (err) {
      handleGraphConnectionError(err, res, 'resolve');
    }
  });

  router.post('/settings/storage-target/test-upload', requireMaster, async (_req, res) => {
    try {
      const target = ctx.settings.storageTarget();
      const result = await ctx.sharePoint.uploadConnectionTestImage(
        createConnectionTestPng(),
        target.channelFolder
      );
      res.status(201).json({ ...result, target });
    } catch (err) {
      handleGraphConnectionError(err, res, 'upload');
    }
  });

  router.post('/settings/storage-target', requireMaster, async (req, res) => {
    try {
      const target = await ctx.settings.saveStorageTarget(req.body || {});
      res.status(201).json({ target, ...ctx.settings.storageTargets() });
    } catch (err) {
      handleSettingsError(err, res);
    }
  });

  router.put('/settings/storage-target/:id', requireMaster, async (req, res) => {
    try {
      const target = await ctx.settings.saveStorageTarget({ ...req.body, id: req.params.id });
      if (ctx.settings.storageTargets().activeTargetId === target.id) {
        ctx.sharePoint.setStorageTarget({ siteId: target.siteId, driveId: target.driveId });
        await ctx.manualUploads.resetForTarget();
      }
      res.json({ target, ...ctx.settings.storageTargets() });
    } catch (err) { handleSettingsError(err, res); }
  });

  router.post('/settings/storage-target/:id/select', requireMaster, async (req, res) => {
    try {
      const target = await ctx.settings.selectStorageTarget(req.params.id);
      ctx.sharePoint.setStorageTarget({ siteId: target.siteId, driveId: target.driveId });
      await ctx.manualUploads.resetForTarget();
      res.json({ target, ...ctx.settings.storageTargets(), status: ctx.sharePoint.getConfigStatus() });
    } catch (err) {
      handleSettingsError(err, res);
    }
  });

  router.delete('/settings/storage-target/:id', requireMaster, async (req, res) => {
    try {
      await ctx.settings.removeStorageTarget(req.params.id);
      const target = ctx.settings.storageTarget();
      ctx.sharePoint.setStorageTarget({ siteId: target.siteId, driveId: target.driveId });
      await ctx.manualUploads.resetForTarget();
      res.json(ctx.settings.storageTargets());
    } catch (err) { handleSettingsError(err, res); }
  });

  /* ---------------------------------------------------------------- */
  /* Accounts — master, plus 업체 관리자 for its own 시공기사 logins       */
  /* ---------------------------------------------------------------- */

  /** Turns an AdminError into its intended status instead of a blanket 500. */
  const handleAdminError = (err: unknown, res: Response) => {
    if (err instanceof AdminError) {
      res.status(err.status).json({ error: '계정 관리 오류', message: err.message });
      return;
    }
    console.error('[admin] 계정 관리 실패', err);
    res.status(500).json({ error: '계정 관리 실패', message: '요청을 처리하지 못했습니다.' });
  };

  router.get('/accounts', requireManager, async (req, res) => {
    try {
      res.json({ accounts: await ctx.directory.list(req.admin!) });
    } catch (err) {
      handleAdminError(err, res);
    }
  });

  router.post('/accounts', requireManager, async (req, res) => {
    try {
      const account = await ctx.directory.create({
        username: cleanText(req.body?.username, 32),
        displayName: cleanText(req.body?.displayName, 40),
        password: String(req.body?.password || ''),
        role: readRole(req.body?.role) ?? 'TECH',
        constructionTypes: readStringArray(req.body?.constructionTypes),
        technicianId: cleanText(req.body?.technicianId, 40) || undefined,
        actor: req.admin!,
      });
      res.status(201).json({ account, accounts: await ctx.directory.list(req.admin!) });
    } catch (err) {
      handleAdminError(err, res);
    }
  });

  router.patch('/accounts/:username', requireManager, async (req, res) => {
    try {
      const { username } = req.params;
      // One ownership check up front covers every field below.
      await ctx.directory.assertCanManage(username, req.admin!);

      if (typeof req.body?.disabled === 'boolean') {
        await ctx.directory.setDisabled(username, req.body.disabled);
      }

      // Only the master reshapes what a role or a scope means.
      if (req.admin!.role === 'MASTER') {
        const role = readRole(req.body?.role);
        if (role) await ctx.directory.setRole(username, role);

        if (Array.isArray(req.body?.constructionTypes)) {
          await ctx.directory.setConstructionTypes(
            username,
            readStringArray(req.body.constructionTypes)
          );
        }
        if (typeof req.body?.technicianId === 'string' && req.body.technicianId) {
          await ctx.directory.setTechnicianId(username, req.body.technicianId);
        }
      }

      if (typeof req.body?.password === 'string' && req.body.password) {
        await ctx.directory.resetPassword(username, req.body.password);
      }

      res.json({ accounts: await ctx.directory.list(req.admin!) });
    } catch (err) {
      handleAdminError(err, res);
    }
  });

  router.delete('/accounts/:username', requireManager, async (req, res) => {
    try {
      await ctx.directory.assertCanManage(req.params.username, req.admin!);
      await ctx.directory.remove(req.params.username);
      res.json({ accounts: await ctx.directory.list(req.admin!) });
    } catch (err) {
      handleAdminError(err, res);
    }
  });

  return router;
}
