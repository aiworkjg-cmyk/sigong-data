import { Router } from 'express';
import type { Response } from 'express';
import { AdminError, scopeOf } from '../admin-directory';
import { requireManager, requireMaster } from '../auth';
import { config } from '../config';
import { mailer } from '../mailer';
import { SettingsError } from '../settings';
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
import { cleanText, clientIp, generateId } from '../util';

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
const AVAILABLE_TOKENS: { token: string; label: string; sample: string }[] = [
  { token: '{type}', label: '시공종류', sample: '백조' },
  { token: '{region}', label: '지역 (시도+시군구)', sample: '경기도광명시' },
  { token: '{building}', label: '건물·아파트명', sample: '이편한세상' },
  { token: '{dong}', label: '읍면동', sample: '소하동' },
  { token: '{yyyy}', label: '연도', sample: '2026' },
  { token: '{MM}', label: '월', sample: '08' },
  { token: '{dd}', label: '일', sample: '24' },
  { token: '{MMdd}', label: '월일', sample: '0824' },
  { token: '{date}', label: '시공일', sample: '2026-08-24' },
  { token: '{yyyy-MM}', label: '연-월', sample: '2026-08' },
  { token: '{quarter}', label: '분기', sample: 'Q3' },
  { token: '{sido}', label: '시도', sample: '경기도' },
  { token: '{sigungu}', label: '시군구', sample: '광명시' },
  { token: '{address}', label: '입력한 주소 전체', sample: '경기도 광명시 …' },
  { token: '{addressCompact}', label: '주소(공백 제거)', sample: '경기도광명시…' },
  { token: '{siteId}', label: '현장 ID', sample: 'BAEKJO-20260824-001' },
  { token: '{manager}', label: '시공기사', sample: '홍길동(팀장)' },
  { token: '{submittedDate}', label: '제출일', sample: '2026-08-24' },
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
  /* 폴더 생성 규칙 (master only)                                       */
  /* ---------------------------------------------------------------- */

  router.get('/settings/folder-rule', requireMaster, (_req, res) => {
    const rule = ctx.settings.folderRule();
    res.json({
      folderRule: { root: rule.root, segments: rule.segments },
      // Rendered from a fixed sample so the admin sees the shape of the result
      // before saving, not after the next submission lands in the wrong place.
      example: ctx.sharePoint.getConfigStatus().examplePath,
      availableTokens: AVAILABLE_TOKENS,
    });
  });

  router.put('/settings/folder-rule', requireMaster, async (req, res) => {
    try {
      const folderRule = await ctx.settings.setFolderRule({
        root: String(req.body?.root ?? ''),
        segments: readStringArray(req.body?.segments),
      });

      // The service resolves paths from its own copy, so hand it the new rule
      // immediately — otherwise the change would only apply after a restart.
      ctx.sharePoint.rule = folderRule;

      res.json({
        folderRule: { root: folderRule.root, segments: folderRule.segments },
        example: ctx.sharePoint.getConfigStatus().examplePath,
      });
    } catch (err) {
      handleSettingsError(err, res);
    }
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
