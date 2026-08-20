import { Router } from 'express';
import {
  authenticate,
  clearFailures,
  clearSession,
  isLockedOut,
  issueSession,
  readSession,
  recordFailure,
} from '../auth';
import { clientIp } from '../util';

export function createAuthRouter(): Router {
  const router = Router();

  /**
   * Reports whether a session exists. This is a query, not a protected
   * resource, so "not logged in" answers 200 with a null session — the public
   * submission page calls it on load and should not log an auth error.
   */
  router.get('/session', (req, res) => {
    res.json({ session: readSession(req) });
  });

  router.post('/login', (req, res) => {
    const ip = clientIp(req);
    const lockedFor = isLockedOut(ip);

    if (lockedFor > 0) {
      res.status(429).json({
        error: '로그인 제한',
        message: `로그인 시도가 너무 많습니다. ${Math.ceil(lockedFor / 60)}분 후 다시 시도해 주세요.`,
      });
      return;
    }

    const username = String(req.body?.username || '');
    const password = String(req.body?.password || '');

    if (!authenticate(username, password)) {
      recordFailure(ip);
      // Deliberately vague: never reveal which half of the pair was wrong.
      res.status(401).json({
        error: '로그인 실패',
        message: '아이디 또는 비밀번호가 올바르지 않습니다.',
      });
      return;
    }

    clearFailures(ip);
    res.json({ session: issueSession(res) });
  });

  router.post('/logout', (_req, res) => {
    clearSession(res);
    res.json({ success: true });
  });

  return router;
}
