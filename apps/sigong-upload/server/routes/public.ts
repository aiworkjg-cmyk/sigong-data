import fs from 'fs';
import { Router } from 'express';
import type { Request } from 'express';
import multer from 'multer';
import { config } from '../config';
import type { AppContext } from '../context';
import { stagingDirFor, storedNameFor } from '../submission';
import {
  cleanText,
  clientIp,
  decodeMultipartFilename,
  generateSiteId,
  removeQuietly,
} from '../util';

/** Set before multer runs so every staged file lands in the submission's folder. */
interface SubmissionRequest extends Request {
  siteId?: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Attachments are streamed to disk rather than buffered. Fifty 100MB videos
 * would be 5GB in memory; on disk the process only ever holds one upload chunk.
 */
function createUploader() {
  const storage = multer.diskStorage({
    destination(req: SubmissionRequest, _file, callback) {
      const dir = stagingDirFor(req.siteId!);
      fs.mkdir(dir, { recursive: true }, (err) => callback(err, dir));
    },
    filename(req, file, callback) {
      // Repair the latin1-decoded filename once, here, before anything reads
      // it. Multer hands this same object to req.files, so the corrected name
      // is what the record and the library both end up with.
      file.originalname = decodeMultipartFilename(file.originalname);

      // Staged under the exact name the worker will use, so it can locate the
      // file from the stored record alone. Multer invokes this in request
      // order, which is the order accept() enumerates req.files in.
      const counter = req as SubmissionRequest & { fileIndex?: number };
      const index = counter.fileIndex ?? 0;
      counter.fileIndex = index + 1;
      callback(null, storedNameFor(index, file.originalname));
    },
  });

  return multer({
    storage,
    limits: { fileSize: config.uploads.maxFileSizeBytes, files: config.uploads.maxFiles },
    fileFilter(_req, file, callback) {
      if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
        callback(null, true);
        return;
      }
      callback(
        new Error(
          `지원되지 않는 파일 형식입니다 (${file.originalname}). 사진 또는 동영상만 업로드할 수 있습니다.`
        )
      );
    },
  });
}

export function createPublicRouter(ctx: AppContext): Router {
  const router = Router();
  const upload = createUploader();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  /** Everything the submission form needs to render. Nothing sensitive here. */
  router.get('/config', (_req, res) => {
    res.json({
      mode: ctx.sharePoint.getConfigStatus().mode,
      constructionTypes: config.constructionTypes,
      maxFiles: config.uploads.maxFiles,
      maxFileSizeMb: Math.floor(config.uploads.maxFileSizeBytes / (1024 * 1024)),
    });
  });

  /**
   * Progress for the confirmation screen. Deliberately minimal — the id is the
   * only thing the submitter holds, so this exposes no personal data.
   */
  router.get('/sites/:id/status', async (req, res) => {
    const record = await ctx.repos.sites.get(req.params.id);
    if (!record) {
      res.status(404).json({ error: '접수 내역을 찾을 수 없습니다.' });
      return;
    }

    const messages: Record<string, string> = {
      QUEUED: '접수되었습니다. 저장 처리를 기다리는 중입니다.',
      PROCESSING: '자료를 저장소에 보관하는 중입니다.',
      COMPLETED: '모든 자료가 정상적으로 보관되었습니다.',
      PARTIAL: '일부 파일 보관에 실패했습니다. 관리자가 확인 후 처리합니다.',
      FAILED: '자료 보관에 실패했습니다. 관리자에게 자동으로 통보되었습니다.',
    };

    res.json({
      id: record.id,
      status: record.status,
      totalFiles: record.files.length,
      storedFiles: record.files.filter((file) => file.status === 'completed').length,
      message: messages[record.status] || '',
    });
  });

  router.post(
    '/sites',
    (req: SubmissionRequest, _res, next) => {
      // Assigned up front so multer knows where to stage before any field is parsed.
      req.siteId = generateSiteId();
      next();
    },
    (req, res, next) => {
      upload.array('files', config.uploads.maxFiles)(req, res, (err) => {
        if (!err) return next();

        void removeQuietly(stagingDirFor((req as SubmissionRequest).siteId!));

        if (err instanceof multer.MulterError) {
          const messages: Record<string, string> = {
            LIMIT_FILE_SIZE: `파일 1개의 최대 용량은 ${Math.floor(config.uploads.maxFileSizeBytes / (1024 * 1024))}MB입니다.`,
            LIMIT_FILE_COUNT: `파일은 최대 ${config.uploads.maxFiles}개까지 업로드할 수 있습니다.`,
          };
          return res.status(400).json({
            error: '파일 업로드 오류',
            message: messages[err.code] || err.message,
          });
        }
        return res.status(400).json({ error: '입력 검증 오류', message: err.message });
      });
    },
    async (req: SubmissionRequest, res) => {
      const siteId = req.siteId!;
      const files = (req.files as Express.Multer.File[]) || [];

      const constructionType = cleanText(req.body?.constructionType, 40);
      const managerName = cleanText(req.body?.managerName, 60);
      const address = cleanText(req.body?.address, 300);
      const constructionDate = cleanText(req.body?.constructionDate, 10);
      const notes = cleanText(req.body?.notes, 2000);

      const reject = async (message: string) => {
        await removeQuietly(stagingDirFor(siteId));
        res.status(400).json({ error: '필수 입력 누락', message });
      };

      // Never trust the posted value — it becomes a folder name.
      if (!config.constructionTypes.includes(constructionType)) {
        return reject('시공종류를 선택해 주세요.');
      }
      if (!managerName) return reject('담당자 이름을 입력해 주세요.');
      if (!address) return reject('현장 주소를 입력해 주세요.');
      if (!DATE_PATTERN.test(constructionDate)) return reject('시공일을 달력에서 선택해 주세요.');
      if (files.length === 0) return reject('사진 또는 동영상을 1개 이상 첨부해 주세요.');

      try {
        const actor = {
          clientIp: clientIp(req),
          userAgent: String(req.headers['user-agent'] || ''),
        };

        // Records the submission without touching the network, then answers
        // immediately. Filing into the library continues on the worker, so the
        // submitter is never held on the page waiting for SharePoint.
        const record = await ctx.intake.accept(
          { siteId, constructionType, managerName, address, constructionDate, notes, ...actor },
          files
        );

        ctx.worker.enqueue({ siteId: record.id, ...actor });

        res.status(202).json({
          success: true,
          message: '현장자료가 정상적으로 접수되었습니다.',
          site: record,
        });
      } catch (err: any) {
        console.error('[submit] 현장자료 접수 실패', err);
        await removeQuietly(stagingDirFor(siteId));
        res.status(500).json({
          error: '현장자료 접수 실패',
          message: '서버 오류로 접수에 실패했습니다. 잠시 후 다시 시도해 주세요.',
        });
      }
    }
  );

  return router;
}
