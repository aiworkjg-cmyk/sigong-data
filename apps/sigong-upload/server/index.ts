import path from 'path';
import express from 'express';
import { config } from './config';
import { requireAdmin } from './auth';
import { createContext } from './context';
import { createAdminRouter } from './routes/admin';
import { createAuthRouter } from './routes/auth';
import { createPublicRouter } from './routes/public';

/** Conservative headers for an app that accepts uploads from anonymous users. */
function securityHeaders(): express.RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
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

  app.use(((err, _req, res, _next) => {
    console.error('[server] 처리되지 않은 오류', err);
    if (res.headersSent) return;
    res.status(500).json({ error: '서버 오류', message: '요청 처리 중 오류가 발생했습니다.' });
  }) as express.ErrorRequestHandler);

  const server = app.listen(config.port, '0.0.0.0', () => {
    const status = ctx.sharePoint.getConfigStatus();
    console.log(`시공현장 자료 수집 서버 실행 중 — port ${config.port}`);
    console.log(`  저장 모드   : ${status.mode}`);
    console.log(`  기록 저장소 : ${ctx.repos.backend}`);
    console.log(`  분류 경로 예: ${status.examplePath}`);
    console.log(`  시공종류    : ${config.constructionTypes.join(', ')}`);
  });

  // Long uploads must not be cut off by the default 2-minute header timeout.
  server.requestTimeout = 30 * 60 * 1000;
  server.headersTimeout = 31 * 60 * 1000;

  const shutdown = (signal: string) => {
    console.log(`[server] ${signal} 수신 — 종료합니다.`);
    // Stop taking new filing work; anything unfinished is re-queued on boot.
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
