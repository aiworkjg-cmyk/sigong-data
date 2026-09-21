import fs from 'fs';
import { Router } from 'express';
import type { Request } from 'express';
import multer from 'multer';
import { config } from '../config';
import { mailer } from '../mailer';
import { formatTechnicians } from '../../src/types';
import type { AppContext } from '../context';
import { stagingDirFor, storedNameFor } from '../submission';
import {
  cleanText,
  clientIp,
  decodeMultipartFilename,
  generateStagingId,
  removeQuietly,
} from '../util';

/** Set before multer runs so every staged file lands in the submission's folder. */
interface SubmissionRequest extends Request {
  siteId?: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Roster ids from a multipart body. A single-value field arrives as a string
 * and a repeated one as an array, so both shapes are normalized here.
 */
function readIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return raw
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 20);
}

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
      constructionTypes: ctx.settings.constructionTypes(),
      constructionTypeConfigs: ctx.settings.constructionTypeConfigs(),
      technicians: ctx.settings.technicians(),
      submissionOrders: ctx.settings.submissionOrders(),
      maxFiles: config.uploads.maxFiles,
      maxFileSizeMb: Math.floor(config.uploads.maxFileSizeBytes / (1024 * 1024)),
    });
  });

  /**
   * Progress for the confirmation screen. Deliberately minimal — the id is the
   * only thing the submitter holds, so this exposes no personal data.
   */
  /**
   * 시공종류별로 자료를 기다리고 있는 현장 수.
   *
   * 제출 화면의 첫 단계입니다. 로그인 없이 열리는 화면이므로 여기서는 건수만
   * 돌려주고, 실제 주소·주문자 같은 개인정보는 시공종류를 고른 뒤에 나갑니다.
   */
  router.get('/work-orders/summary', async (_req, res) => {
    try {
      res.json({ summary: await ctx.workOrders.summary() });
    } catch (err) {
      console.error('[public] 시공건 요약 조회 실패', err);
      res.status(500).json({ error: '조회 실패', message: '목록을 불러오지 못했습니다.' });
    }
  });

  /**
   * 한 시공종류의 대기 중인 현장을, 날짜 → 지역으로 묶어서.
   *
   * 시공종류를 반드시 지정하게 한 것은 의도적입니다. 전체 목록을 한 번에 여는
   * 주소는 곧 전체 고객 명단을 여는 주소이고, 이 화면에는 로그인이 없습니다.
   */
  /**
   * 이 시공종류에 등록된 현장종류 목록.
   *
   * 따로 관리하는 목록이 아닙니다 — 주문서 시트 이름이 곧 현장종류이므로,
   * 등록된 주문에서 뽑으면 늘 실제와 일치하고 유지보수할 것이 없습니다.
   * 직접 입력할 때 이 목록에서 고르게 해서, 손으로 친 이름이 새 폴더를
   * 만들어 버리는 일을 막습니다.
   */
  router.get('/work-orders/site-types', async (req, res) => {
    try {
      const constructionType = cleanText(req.query?.constructionType, 40);
      if (!ctx.settings.constructionTypes().includes(constructionType)) {
        res.json({ siteTypes: [] });
        return;
      }
      const { items } = await ctx.workOrders.list({
        constructionTypes: [constructionType],
        limit: 2000,
      });
      const names = [...new Set(items.map((order) => order.siteType).filter(Boolean))] as string[];
      res.json({ siteTypes: names.sort((a, b) => a.localeCompare(b, 'ko')) });
    } catch (err) {
      console.error('[public] 현장종류 조회 실패', err);
      res.json({ siteTypes: [] });
    }
  });

  router.get('/work-orders', async (req, res) => {
    try {
      const constructionType = cleanText(req.query?.constructionType, 40);
      if (!ctx.settings.constructionTypes().includes(constructionType)) {
        res.status(400).json({ error: '입력 오류', message: '시공종류를 먼저 선택해 주세요.' });
        return;
      }
      // 날짜를 하나만 받습니다. 기사 화면은 "오늘 갈 곳"을 보는 화면이고,
      // 기간 조회는 관리자 화면의 일입니다.
      const date = cleanText(req.query?.date, 10);
      // 담당 기사로 거르지 않습니다.
      //
      // 주문서의 기사명은 "예정"이고, 실제로 간 사람이 다른 경우가 흔합니다.
      // 그걸로 목록을 좁히면 대신 간 기사에게는 자기 현장이 사라져 보이고,
      // 결국 직접 입력으로 새 표기를 만들어 냅니다. 날짜와 현장종류만으로
      // 좁히고, 누가 갔는지는 제출할 때 따로 받습니다.
      const groups = await ctx.workOrders.grouped({
        constructionTypes: [constructionType],
        siteType: cleanText(req.query?.siteType, 60) || undefined,
        search: cleanText(req.query?.search, 100) || undefined,
        from: date || undefined,
        to: date || undefined,
      });
      // 연락처는 기사 화면에 쓸 데가 없습니다. 화면에서 가리는 것만으로는
      // 개발자 도구로 그대로 보이므로, 아예 내보내지 않습니다.
      res.json({
        groups: groups.map((group) => ({
          ...group,
          regions: group.regions.map((entry) => ({
            ...entry,
            orders: entry.orders.map(({ phone: _phone, ...order }) => order),
          })),
        })),
      });
    } catch (err) {
      console.error('[public] 시공건 목록 조회 실패', err);
      res.status(500).json({ error: '조회 실패', message: '목록을 불러오지 못했습니다.' });
    }
  });

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
      // A placeholder so multer has somewhere to stage; the real id is assigned
      // once the form fields have been parsed.
      req.siteId = generateStagingId();
      next();
    },
    (req, res, next) => {
      upload.array('files', config.uploads.maxFiles)(req, res, (err) => {
        if (!err) return next();

        void removeQuietly(stagingDirFor((req as SubmissionRequest).siteId!));
        void notifyRejectedUpload(ctx, req as SubmissionRequest, err.message || '파일 수신 실패');

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
      let siteId = req.siteId!;
      const files = (req.files as Express.Multer.File[]) || [];

      const constructionType = cleanText(req.body?.constructionType, 40);
      let postedFieldValues: Record<string, string> = {};
      try {
        const parsed = JSON.parse(String(req.body?.fieldValues || '{}'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) postedFieldValues = parsed;
      } catch {
        postedFieldValues = {};
      }
      // The form posts roster ids, never free text — the names and titles are
      // resolved here so a crafted request cannot invent a technician.
      const technicians = ctx.settings
        .resolveTechnicians(readIds(req.body?.technicianIds))
        .map((tech) => ({ id: tech.id, name: tech.name, title: tech.title }));
      const reject = async (message: string) => {
        void notifyRejectedUpload(ctx, req, message);
        await removeQuietly(stagingDirFor(siteId));
        res.status(400).json({ error: '필수 입력 누락', message });
      };

      const workOrderId = cleanText(req.body?.workOrderId, 60);
      // 직접 입력일 때만 씁니다. 주문건을 골랐다면 그 건의 값이 이깁니다.
      let siteType = cleanText(req.body?.siteType, 60);
      let address = cleanText(req.body?.address, 300);
      let constructionDate = cleanText(req.body?.constructionDate, 10);
      const notes = cleanText(req.body?.notes, 2000);
      // 직접 입력일 때만 씁니다. 주문건을 골랐다면 그 건의 주문자가 이깁니다.
      let customerName = cleanText(req.body?.customerName, 60);

      // When a 시공건 was picked, its stored values win over anything the form
      // posted. The point of the list is that the address is typed once, by the
      // office, from the order sheet — re-accepting a hand-typed copy here would
      // put the transcription mistakes straight back in.
      const workOrder = workOrderId
        ? await ctx.repos.workOrders.get(workOrderId).catch(() => null)
        : null;
      if (workOrderId && !workOrder) {
        return reject('선택한 시공건을 찾을 수 없습니다. 목록을 새로고침한 뒤 다시 골라 주세요.');
      }
      if (workOrder) {
        if (workOrder.constructionType !== constructionType) {
          return reject('선택한 시공건의 시공종류가 화면과 다릅니다. 목록에서 다시 골라 주세요.');
        }
        address = workOrder.address;
        siteType = workOrder.siteType || siteType;
        customerName = workOrder.customerName || customerName;
        // 주문서에 시공예정일이 없던 건이면 화면에서 고른 날짜를 그대로 씁니다.
        constructionDate = workOrder.scheduledDate || constructionDate;
      }

      // 직접 입력한 현장은 주문자명이 있어야 합니다. 주문건에서 온 건은 위에서
      // 그 값으로 덮어썼으므로 여기서 걸리지 않습니다.
      if (!workOrder && !customerName) {
        return reject('주문자명을 입력해 주세요.');
      }

      // Never trust the posted value — it becomes a folder name. Checked against
      // the live list so a type removed in 설정 stops being accepted at once.
      if (!ctx.settings.constructionTypes().includes(constructionType)) {
        return reject('시공종류를 선택해 주세요.');
      }
      const typeConfig = ctx.settings.constructionTypeConfig(constructionType)!;
      const customFields = typeConfig.fields.map((field) => ({
        id: field.id,
        label: field.label,
        token: field.token,
        value: cleanText(postedFieldValues[field.id], 200),
      }));
      for (const field of typeConfig.fields) {
        const value = customFields.find((entry) => entry.id === field.id)?.value || '';
        if (field.required && !value) return reject(`${field.label} 항목을 입력해 주세요.`);
        if (field.inputType === 'select' && value && !field.options.includes(value)) {
          return reject(`${field.label} 항목은 설정에 등록된 값에서 선택해 주세요.`);
        }
      }
      if (technicians.length === 0) return reject('시공기사를 1명 이상 선택해 주세요.');
      if (!address) return reject('현장 주소를 입력해 주세요.');
      if (!DATE_PATTERN.test(constructionDate)) return reject('시공일을 달력에서 선택해 주세요.');
      if (files.length === 0) return reject('사진 또는 동영상을 1개 이상 첨부해 주세요.');

      try {
        // Now that the 시공종류 and 시공일 are known, swap the placeholder for the
        // real id and move the staged files with it, so the worker can still
        // find them from the stored record alone.
        const finalId = await ctx.siteIds.next(constructionType, constructionDate, async (id) =>
          Boolean(await ctx.repos.sites.get(id))
        );
        try {
          await fs.promises.rename(stagingDirFor(siteId), stagingDirFor(finalId));
          siteId = finalId;
        } catch (err) {
          // Keeping the placeholder id is ugly but harmless; losing the files
          // would not be, so a failed rename must not abort the submission.
          console.error(`[submit] 임시 폴더 이름 변경 실패 — ${siteId} 유지`, err);
        }

        const actor = {
          clientIp: clientIp(req),
          userAgent: String(req.headers['user-agent'] || ''),
        };

        // Records the submission without touching the network, then answers
        // immediately. Filing into the library continues on the worker, so the
        // submitter is never held on the page waiting for SharePoint.
        const record = await ctx.intake.accept(
          {
            siteId,
            constructionType,
            // 주문건(시트 이름)에서 온 값이 우선입니다. 그 값이 없을 때만
            // 시공종류별 입력 항목의 siteType 필드를 씁니다.
            siteType:
              siteType || customFields.find((field) => field.token === 'siteType')?.value || undefined,
            customerName:
              customerName ||
              customFields.find((field) => field.token === 'customerName')?.value ||
              undefined,
            customFields,
            technicians,
            managerName: formatTechnicians(technicians),
            address,
            constructionDate,
            notes,
            workOrderId: workOrder?.id,
            ...actor,
          },
          files
        );

        // Closed only after the submission is safely recorded, and never in a
        // way that can fail the submission — see WorkOrderService.markSubmitted.
        if (workOrder) await ctx.workOrders.markSubmitted(workOrder.id, record.id);

        ctx.worker.enqueue({ siteId: record.id, ...actor });

        res.status(202).json({
          success: true,
          message: '현장자료가 정상적으로 접수되었습니다.',
          site: record,
        });
      } catch (err: any) {
        console.error('[submit] 현장자료 접수 실패', err);
        void notifyRejectedUpload(ctx, req, err?.message || '현장자료 접수 실패');
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

async function notifyRejectedUpload(ctx: AppContext, req: SubmissionRequest, error: string): Promise<void> {
  try {
    const workOrderId = cleanText(req.body?.workOrderId, 120);
    const order = workOrderId ? await ctx.repos.workOrders.get(workOrderId) : null;
    await mailer.notifyQuietly({
      id: req.siteId || '접수 전', constructionType: order?.constructionType || cleanText(req.body?.constructionType, 40),
      workOrderId, customerName: order?.customerName || cleanText(req.body?.customerName, 80),
      address: order?.address || cleanText(req.body?.address, 300),
      managerName: order?.technicianName || '접수 전 — 기사 정보 확인 필요',
      constructionDate: order?.scheduledDate || cleanText(req.body?.constructionDate, 10),
      createdAt: new Date().toISOString(), status: 'FAILED', folderPath: '저장 전', files: [],
      notes: cleanText(req.body?.notes, 500), retryAvailable: false,
      syncMessage: `파일 접수 실패: ${error}. 브라우저에 전달된 정보까지만 표시됩니다. 다시 제출해 주세요.`,
    }, [error], ctx.settings.deleteRequestEmails(), order);
  } catch (err) { console.error('[mail] 접수 실패 알림 처리 오류', err); }
}
