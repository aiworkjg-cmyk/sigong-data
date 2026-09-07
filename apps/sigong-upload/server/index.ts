import path from 'path';
import express from 'express';
import { config } from './config';
import { requireAdmin } from './auth';
import { createContext } from './context';
import { createAdminRouter } from './routes/admin';
import { createAuthRouter } from './routes/auth';
import { createPublicRouter } from './routes/public';
import { createWorkOrderRouter } from './routes/work-orders';
import { createExportRouter } from './routes/export';

/** Conservative headers for an app that accepts uploads from anonymous users. */
function securityHeaders(): express.RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // DENY 가 아니라 SAMEORIGIN.
    //
    // 클릭재킹을 막는 것이 목적인데, 그 목적에는 SAMEORIGIN 으로 충분합니다 —
    // 남의 사이트가 이 화면을 자기 페이지에 끼워 넣는 것은 그대로 막힙니다.
    // DENY 는 우리 자신도 못 끼우게 해서, 관리자 화면의 모바일 미리보기
    // (같은 출처 iframe)가 "연결을 거부했습니다" 로 뜹니다.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    // allow-popups rather than plain same-origin: the Microsoft sign-in in the
    // 설정 화면 opens a popup that navigates to login.microsoftonline.com and
    // comes back. Under 'same-origin' the browser severs that popup into its own
    // browsing context group, so the callback page loses window.opener and the
    // admin page loses track of the window it just opened. This variant keeps
    // that link for popups *we* open while still refusing to let a cross-origin
    // opener hold a reference to this page.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    // The submission link is meant to be shared, not indexed.
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  };
}

async function startServer(): Promise<void> {
  const ctx = await createContext();
  const app = express();

  // App Service terminates TLS upstream; trust it so secure cookies and the
  // client IP in the audit log are correct.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(securityHeaders());

  // Bodies here are JSON only — attachments arrive as multipart via multer.
  // Mounted ahead of the 1mb parser with a larger limit of its own: the 주문서
  // review screen posts the whole parsed table back when the column mapping
  // changes, and a few hundred rows of addresses clears 1mb easily.
  app.use(
    '/api/admin/work-orders',
    express.json({ limit: '12mb' }),
    requireAdmin(ctx.directory),
    createWorkOrderRouter(ctx)
  );

  // 내보내기도 목록 전체를 본문으로 받으므로 같은 이유로 한도를 올립니다.
  app.use(
    '/api/admin/export',
    express.json({ limit: '12mb' }),
    requireAdmin(ctx.directory),
    createExportRouter(ctx)
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use('/api', createPublicRouter(ctx));
  app.use('/api/admin', createAuthRouter(ctx));
  app.use('/api/admin', requireAdmin(ctx.directory), createAdminRouter(ctx));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: '요청한 API를 찾을 수 없습니다.' });
  });

  if (config.isProduction) {
    const webRoot = path.join(__dirname, 'web');
    app.use(express.static(webRoot, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(webRoot, 'index.html')));
  } else {
    // Vite is a dev-only dependency; importing it lazily keeps it out of the
    // production bundle entirely.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  }

  app.use(((err, req, res, _next) => {
    console.error(`[server] 처리되지 않은 오류 — ${req.method} ${req.originalUrl}`, err);
    if (res.headersSent) return;

    // multer 는 업로드 오류를 next(err) 로 넘기므로 라우트의 try/catch 를
    // 지나쳐 여기까지 옵니다. 그때 "요청 처리 중 오류" 한 줄만 보이면 파일이
    // 큰 것인지 형식이 틀린 것인지 알 방법이 없어, 이름을 붙여 돌려줍니다.
    const multerMessages: Record<string, string> = {
      LIMIT_FILE_SIZE: '파일이 너무 큽니다. 더 작은 파일로 나눠 올려 주세요.',
      LIMIT_FILE_COUNT: '한 번에 올릴 수 있는 파일 수를 넘었습니다.',
      LIMIT_UNEXPECTED_FILE: '예상하지 못한 파일 항목입니다. 화면을 새로고침한 뒤 다시 시도해 주세요.',
      LIMIT_PART_COUNT: '전송 항목이 너무 많습니다.',
    };
    const code = (err as { code?: string })?.code || '';
    if (multerMessages[code]) {
      res.status(400).json({ error: '업로드 오류', message: multerMessages[code] });
      return;
    }
    if (code === 'ENTITY_TOO_LARGE' || (err as { type?: string })?.type === 'entity.too.large') {
      res.status(413).json({
        error: '요청이 너무 큽니다',
        message: '한 번에 보낼 수 있는 양을 넘었습니다. 줄 수를 나눠 등록해 주세요.',
      });
      return;
    }

    // 운영에서는 내부 사정을 감추되, 개발 중에는 실제 원인을 보여 줍니다 —
    // 그것을 감추느라 진단이 몇 시간씩 늦어지는 편이 더 나쁩니다.
    res.status(500).json({
      error: '서버 오류',
      message: config.isProduction
        ? '요청 처리 중 오류가 발생했습니다. 관리자에게 문의해 주세요.'
        : `요청 처리 중 오류가 발생했습니다 — ${(err as Error)?.message || err}`,
    });
  }) as express.ErrorRequestHandler);

  const server = app.listen(config.port, '0.0.0.0', () => {
    const status = ctx.sharePoint.getConfigStatus();
    console.log(`시공현장 자료 수집 서버 실행 중 — port ${config.port}`);
    console.log(`  저장 모드   : ${status.mode}`);
    console.log(`  기록 저장소 : ${ctx.repos.backend}`);
    console.log(`  분류 경로 예: ${status.examplePath}`);
    console.log(`  시공종류    : ${ctx.settings.constructionTypes().join(', ') || '(없음)'}`);
  });

  // Long uploads must not be cut off by the default 2-minute header timeout.
  server.requestTimeout = 30 * 60 * 1000;
  server.headersTimeout = 31 * 60 * 1000;

  const shutdown = (signal: string) => {
    console.log(`[server] ${signal} 수신 — 종료합니다.`);
    // Stop taking new filing work; anything unfinished is re-queued on boot.
    ctx.manualUploads.shutdown();
    ctx.worker.shutdown();
    server.close(() => process.exit(0));
    // Force-exit if connections refuse to drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch((err) => {
  console.error('서버 시작 실패:', err instanceof Error ? err.message : err);
  process.exit(1);
});
