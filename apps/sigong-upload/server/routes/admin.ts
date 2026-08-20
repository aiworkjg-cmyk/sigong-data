import { Router } from 'express';
import type { Response } from 'express';
import { AdminError } from '../admin-directory';
import { requireMaster } from '../auth';
import { config } from '../config';
import { mailer } from '../mailer';
import type { AppContext } from '../context';
import type { Issue, IssuePriority, IssueStatus } from '../../src/types';
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

export function createAdminRouter(ctx: AppContext): Router {
  const router = Router();

  /* ---------------------------------------------------------------- */
  /* Diagnostics                                                       */
  /* ---------------------------------------------------------------- */

  router.get('/diagnostics', async (_req, res) => {
    const sharePoint = ctx.sharePoint.getConfigStatus();
    // Only probe live credentials; test mode has nothing to reach.
    const connectivity = sharePoint.isLiveConfigured ? await ctx.sharePoint.probe() : null;

    res.json({
      sharePoint,
      connectivity,
      recordBackend: ctx.repos.backend,
      constructionTypes: config.constructionTypes,
      mail: {
        configured: mailer.isConfigured(),
        sender: config.mail.sender,
        recipients: config.mail.alertRecipients,
      },
      warnings: ctx.warnings,
    });
  });

  router.get('/folders', async (req, res) => {
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
  /* Sites                                                             */
  /* ---------------------------------------------------------------- */

  router.get('/sites', async (req, res) => {
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

  router.get('/sites/:id', async (req, res) => {
    const site = await ctx.repos.sites.get(req.params.id);
    if (!site) {
      res.status(404).json({ error: '현장을 찾을 수 없습니다.' });
      return;
    }
    res.json({ site });
  });

  /**
   * Queues another filing attempt. Returns straight away — progress shows up in
   * the record's status, the same path an automatic retry takes.
   */
  router.post('/sites/:id/retry', async (req, res) => {
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

  router.get('/logs', async (req, res) => {
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

  router.get('/logs/summary', async (req, res) => {
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

  router.get('/issues', async (req, res) => {
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

  router.post('/issues', async (req, res) => {
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

  router.patch('/issues/:id', async (req, res) => {
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

  router.post('/issues/:id/comments', async (req, res) => {
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

  router.delete('/issues/:id', async (req, res) => {
    await ctx.repos.issues.remove(req.params.id);
    res.json({ success: true });
  });

  /* ---------------------------------------------------------------- */
  /* Admin accounts (master only)                                      */
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

  router.get('/accounts', requireMaster, async (_req, res) => {
    try {
      res.json({ accounts: await ctx.directory.list() });
    } catch (err) {
      handleAdminError(err, res);
    }
  });

  router.post('/accounts', requireMaster, async (req, res) => {
    try {
      const account = await ctx.directory.create({
        username: cleanText(req.body?.username, 32),
        displayName: cleanText(req.body?.displayName, 40),
        password: String(req.body?.password || ''),
        createdBy: req.admin?.username || 'master',
      });
      res.status(201).json({ account });
    } catch (err) {
      handleAdminError(err, res);
    }
  });

  router.patch('/accounts/:username', requireMaster, async (req, res) => {
    try {
      const { username } = req.params;

      if (typeof req.body?.disabled === 'boolean') {
        await ctx.directory.setDisabled(username, req.body.disabled);
      }
      if (typeof req.body?.password === 'string' && req.body.password) {
        await ctx.directory.resetPassword(username, req.body.password);
      }

      res.json({ accounts: await ctx.directory.list() });
    } catch (err) {
      handleAdminError(err, res);
    }
  });

  router.delete('/accounts/:username', requireMaster, async (req, res) => {
    try {
      await ctx.directory.remove(req.params.username);
      res.json({ accounts: await ctx.directory.list() });
    } catch (err) {
      handleAdminError(err, res);
    }
  });

  return router;
}
