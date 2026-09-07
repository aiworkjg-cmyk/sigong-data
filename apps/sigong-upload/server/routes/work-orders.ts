import { Router } from 'express';
import { WORK_ORDER_SORTS } from '../../src/types';
import type { WorkOrderSort } from '../../src/types';
import type { Response } from 'express';
import multer from 'multer';
import { requireManager, requireMaster } from '../auth';
import { scopeOf } from '../admin-directory';
import { GoogleSheetError, GoogleSheetService } from '../google-sheet';
import { GoogleAuthError } from '../google-account';
import { OcrError, isOcrConfigured, readOrderImage } from '../ocr';
import { buildDrafts, detectMapping, EMPTY_MAPPING } from '../order-import';
import { parseCsv, parseWorkbook } from '../spreadsheet';
import { WorkOrderError } from '../work-orders';
import { cleanText, escapeHtml } from '../util';
import type { AppContext } from '../context';
import type {
  WorkOrderColumnMap,
  WorkOrderDraft,
  WorkOrderStatus,
} from '../../src/types';

/** 주문서 한 장의 상한. 이미지는 크고, 엑셀은 작습니다. */
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_BYTES, files: 1 },
});

const STATUSES: WorkOrderStatus[] = ['OPEN', 'SUBMITTED', 'CANCELLED'];

function readStatus(value: unknown): WorkOrderStatus | undefined {
  return STATUSES.includes(value as WorkOrderStatus) ? (value as WorkOrderStatus) : undefined;
}

function readMapping(value: unknown): WorkOrderColumnMap {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const mapping = { ...EMPTY_MAPPING };
  for (const field of Object.keys(mapping) as Array<keyof WorkOrderColumnMap>) {
    mapping[field] = cleanText(raw[field], 120);
  }
  return mapping;
}

/** Rebuilds the reviewed rows the browser posted back. */
function readDrafts(value: unknown): WorkOrderDraft[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw: any, index) => ({
    rowKey: cleanText(raw?.rowKey, 40) || `row-${index}`,
    constructionType: cleanText(raw?.constructionType, 40),
    siteType: cleanText(raw?.siteType, 60),
    technicianName: cleanText(raw?.technicianName, 40),
    orderNumber: cleanText(raw?.orderNumber, 60),
    customerName: cleanText(raw?.customerName, 60),
    phone: cleanText(raw?.phone, 20),
    address: cleanText(raw?.address, 300),
    scheduledDate: cleanText(raw?.scheduledDate, 10),
    notes: cleanText(raw?.notes, 500),
    extras: Array.isArray(raw?.extras)
      ? raw.extras
          .slice(0, 40)
          .map((entry: any) => ({
            label: cleanText(entry?.label, 60),
            value: cleanText(entry?.value, 300),
          }))
          .filter((entry: { label: string }) => entry.label)
      : [],
    problems: [],
    cancelled: Boolean(raw?.cancelled),
    statusText: cleanText(raw?.statusText, 300),
  }));
}

export function createWorkOrderRouter(ctx: AppContext): Router {
  const router = Router();

  const fail = (err: unknown, res: Response) => {
    if (
      err instanceof WorkOrderError ||
      err instanceof OcrError ||
      err instanceof GoogleSheetError ||
      err instanceof GoogleAuthError
    ) {
      res.status(err.status).json({ error: '주문서 처리 오류', message: err.message });
      return;
    }
    console.error('[orders] 처리 실패', err);
    res.status(500).json({
      error: '주문서 처리 실패',
      message: err instanceof Error ? err.message : '요청을 처리하지 못했습니다.',
    });
  };

  /**
   * 이 계정이 볼 수 있는 시공종류.
   *
   * 업체 관리자는 본인 업체의 주문만 다룹니다. 스코프는 언제나 서버에서
   * 세션으로 결정하며, 요청이 보낸 값은 그 안으로만 좁힐 수 있습니다.
   */
  const scopedTypes = (req: any): string[] | undefined => {
    const scope = scopeOf(req.admin);
    return scope.all ? undefined : scope.constructionTypes;
  };

  /* ---------------------------------------------------------------- */
  /* 목록                                                               */
  /* ---------------------------------------------------------------- */

  /** 모르는 값은 기본(시트 순서)으로 떨어뜨립니다. */
  const readSort = (value: unknown): WorkOrderSort =>
    WORK_ORDER_SORTS.some((entry) => entry.value === value) ? (value as WorkOrderSort) : 'sheet';

  router.get('/', requireManager, async (req, res) => {
    try {
      const requested = cleanText(req.query?.constructionType, 40);
      const allowed = scopedTypes(req);
      const constructionTypes = requested
        ? (allowed && !allowed.includes(requested) ? [] : [requested])
        : allowed;

      const page = await ctx.workOrders.list({
        constructionTypes,
        status: readStatus(req.query?.status),
        from: cleanText(req.query?.from, 10) || undefined,
        to: cleanText(req.query?.to, 10) || undefined,
        region: cleanText(req.query?.region, 40) || undefined,
        search: cleanText(req.query?.search, 100) || undefined,
        sort: readSort(req.query?.sort),
        limit: Math.min(Math.max(Number(req.query?.limit) || 100, 1), 500),
        cursor: typeof req.query?.cursor === 'string' ? req.query.cursor : undefined,
      });
      res.json(page);
    } catch (err) {
      fail(err, res);
    }
  });

  router.get('/summary', requireManager, async (req, res) => {
    try {
      res.json({ summary: await ctx.workOrders.summary(scopedTypes(req)) });
    } catch (err) {
      fail(err, res);
    }
  });

  /**
   * 지금까지 등록된 현장종류 목록.
   *
   * 따로 관리하는 목록이 아니라 등록된 주문에서 뽑아냅니다. 주문서 시트를
   * 올리면 그 시트 이름이 곧 현장종류가 되므로, 목록은 늘 실제 데이터와
   * 일치하고 관리자가 따로 유지보수할 것이 없습니다.
   */
  router.get('/site-types', requireManager, async (req, res) => {
    try {
      const requested = cleanText(req.query?.constructionType, 40);
      const { items } = await ctx.workOrders.list({
        constructionTypes: requested ? [requested] : scopedTypes(req),
        limit: 2000,
      });
      const names = [...new Set(items.map((order) => order.siteType).filter(Boolean))] as string[];
      res.json({ siteTypes: names.sort((a, b) => a.localeCompare(b, 'ko')) });
    } catch (err) {
      fail(err, res);
    }
  });

  /* ---------------------------------------------------------------- */
  /* 주문서 읽기 (등록 전 미리보기)                                      */
  /* ---------------------------------------------------------------- */

  /**
   * 파일을 읽어 확인용 표를 돌려줍니다. 아무것도 저장하지 않습니다.
   *
   * 등록은 별도 요청입니다. 열 연결이 틀렸거나 OCR이 값을 잘못 읽었을 때,
   * 되돌릴 수 없는 저장이 이미 일어난 뒤에 발견되면 곤란하기 때문입니다.
   */
  router.post('/preview', requireManager, upload.single('file'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) throw new WorkOrderError('주문서 파일을 선택해 주세요.');

      const name = (file.originalname || '').toLowerCase();
      const isImage = file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf';
      const isExcel = name.endsWith('.xlsx') || name.endsWith('.xlsm');
      const isCsv = name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt');

      const defaultConstructionType = cleanText(req.body?.constructionType, 40);
      const knownTypes = ctx.settings.constructionTypes();

      /** 시트 이름이 현장종류입니다 — CSV·이미지는 파일 이름을 대신 씁니다. */
      const fallbackSiteType = (file.originalname || '')
        .replace(/\.[^.]+$/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);

      let sheets: Array<{ name: string; table: ReturnType<typeof parseCsv> }>;
      let source: 'EXCEL' | 'CSV' | 'IMAGE';
      let extractedText: string | undefined;

      if (isExcel) {
        sheets = parseWorkbook(file.buffer);
        source = 'EXCEL';
      } else if (isCsv) {
        sheets = [{ name: fallbackSiteType, table: parseCsv(file.buffer.toString('utf-8')) }];
        source = 'CSV';
      } else if (isImage) {
        const read = await readOrderImage(file.buffer, file.mimetype);
        sheets = [{ name: fallbackSiteType, table: read.table }];
        extractedText = read.text;
        source = 'IMAGE';
      } else {
        throw new WorkOrderError(
          '엑셀(.xlsx), CSV, 또는 이미지 파일만 읽을 수 있습니다. (.xls 는 .xlsx 로 저장해 주세요)'
        );
      }

      // 시트마다 열 구성이 다를 수 있으므로 연결도 시트별로 잡습니다.
      // 화면에는 시트 하나씩 확인·등록할 수 있게 통째로 넘깁니다.
      const parsed = await Promise.all(
        sheets.map(async ({ name, table }) => {
          const mapping = detectMapping(table.headers, table.rows);
          const drafts = buildDrafts({
            table,
            mapping,
            defaultConstructionType,
            knownTypes,
            siteType: name,
          });
          return {
            siteType: name,
            headers: table.headers,
            mapping,
            rows: await withDuplicates(drafts),
            warnings: table.warnings,
          };
        })
      );

      res.json({ source, sheets: parsed, extractedText });
    } catch (err) {
      fail(err, res);
    }
  });

  /**
   * 열 연결만 바꿔 다시 계산합니다. 파일을 다시 올리지 않아도 되도록,
   * 브라우저가 들고 있던 표를 그대로 보내옵니다.
   */
  router.post('/remap', requireManager, async (req, res) => {
    try {
      const headers = Array.isArray(req.body?.headers)
        ? req.body.headers.map((value: unknown) => cleanText(value, 120))
        : [];
      const rows = Array.isArray(req.body?.rows)
        ? req.body.rows.map((row: unknown) =>
            Array.isArray(row) ? row.map((cell) => cleanText(cell, 300)) : []
          )
        : [];

      const drafts = buildDrafts({
        table: { headers, rows, warnings: [] },
        mapping: readMapping(req.body?.mapping),
        defaultConstructionType: cleanText(req.body?.constructionType, 40),
        knownTypes: ctx.settings.constructionTypes(),
        siteType: cleanText(req.body?.siteType, 60),
      });
      res.json({ rows: await withDuplicates(drafts) });
    } catch (err) {
      fail(err, res);
    }
  });

  /**
   * Flags rows that already exist, so the review table can say "이미 등록됨"
   * before anything is written rather than reporting it as a skip afterwards.
   */
  async function withDuplicates(drafts: WorkOrderDraft[]): Promise<WorkOrderDraft[]> {
    const { sourceKeyFor } = await import('../order-import');
    return Promise.all(
      drafts.map(async (draft) => {
        if (!draft.address || !draft.scheduledDate) return draft;
        const existing = await ctx.repos.workOrders.findBySourceKey(
          sourceKeyFor({ source: 'EXCEL', ...draft })
        );
        return existing ? { ...draft, duplicateOf: existing.id } : draft;
      })
    );
  }

  /* ---------------------------------------------------------------- */
  /* 등록 · 수정                                                        */
  /* ---------------------------------------------------------------- */

  router.post('/import', requireManager, async (req, res) => {
    try {
      const drafts = readDrafts(req.body?.rows);
      if (drafts.length === 0) throw new WorkOrderError('등록할 줄이 없습니다.');

      const allowed = scopedTypes(req);
      if (allowed) {
        const outside = drafts.find((draft) => !allowed.includes(draft.constructionType));
        if (outside) {
          throw new WorkOrderError(
            `담당하지 않는 시공종류는 등록할 수 없습니다: ${outside.constructionType}`,
            403
          );
        }
      }

      const result = await ctx.workOrders.importDrafts({
        drafts,
        source: (['EXCEL', 'CSV', 'IMAGE', 'MANUAL'] as const).includes(req.body?.source)
          ? req.body.source
          : 'EXCEL',
        createdBy: req.admin?.displayName || '관리자',
        knownTypes: ctx.settings.constructionTypes(),
        overwriteEdited: true,
      });

      // 파일에서 들어온 현장종류(시트 이름)도 선택값으로 남깁니다 — 시트 연동과
      // 같은 규칙이어야 어느 경로로 등록하든 결과가 같습니다.
      const byType = new Map<string, string[]>();
      for (const draft of drafts) {
        if (!draft.siteType) continue;
        byType.set(draft.constructionType, [
          ...(byType.get(draft.constructionType) ?? []),
          draft.siteType,
        ]);
      }
      for (const [type, names] of byType) {
        await ctx.settings.ensureSiteTypeOptions(type, names).catch(() => undefined);
      }

      res.status(201).json(result);
    } catch (err) {
      fail(err, res);
    }
  });

  router.patch('/:id', requireManager, async (req, res) => {
    try {
      const order = await ctx.workOrders.update(
        req.params.id,
        req.body || {},
        ctx.settings.constructionTypes()
      );
      res.json({ order });
    } catch (err) {
      fail(err, res);
    }
  });

  router.post('/:id/status', requireManager, async (req, res) => {
    try {
      const status = readStatus(req.body?.status);
      if (!status) throw new WorkOrderError('상태 값이 올바르지 않습니다.');
      res.json({ order: await ctx.workOrders.setStatus(req.params.id, status) });
    } catch (err) {
      fail(err, res);
    }
  });

  router.delete('/:id', requireMaster, async (req, res) => {
    try {
      await ctx.workOrders.remove(req.params.id);
      res.json({ success: true });
    } catch (err) {
      fail(err, res);
    }
  });

  /* ---------------------------------------------------------------- */
  /* 구글시트 연동                                                      */
  /* ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- */
  /* 구글 계정 연결                                                     */
  /* ---------------------------------------------------------------- */

  router.get('/google', requireMaster, (_req, res) => {
    res.json(ctx.google.view());
  });

  router.post('/google/signin', requireMaster, (_req, res) => {
    try {
      res.json({ ...ctx.google.beginSignIn(), redirectUri: ctx.google.redirectUri });
    } catch (err) {
      fail(err, res);
    }
  });

  /**
   * 구글이 브라우저를 돌려보내는 곳. JSON 이 아니라 페이지로 답합니다 —
   * 관리자가 보고 있는 팝업의 최상위 이동이라 사람이 읽을 말이 필요합니다.
   */
  router.get('/google/callback', requireMaster, async (req, res) => {
    const done = (ok: boolean, message: string) => {
      res.status(ok ? 200 : 400).type('html').send(
        `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Google 연결</title></head>
<body style="font-family:system-ui,sans-serif;padding:32px;text-align:center">
<h2 style="color:${ok ? '#047857' : '#b91c1c'}">${ok ? '연결되었습니다' : '연결하지 못했습니다'}</h2>
<p style="color:#475569;font-size:14px;max-width:520px;margin:12px auto">${escapeHtml(message)}</p>
<p style="color:#94a3b8;font-size:12px">이 창은 잠시 후 자동으로 닫힙니다.</p>
<script>setTimeout(function(){window.close();}, ${ok ? 1200 : 6000});</script>
</body></html>`
      );
    };

    const failure = cleanText(req.query?.error_description, 400) || cleanText(req.query?.error, 200);
    if (failure) {
      done(false, failure);
      return;
    }
    try {
      await ctx.google.completeSignIn(
        cleanText(req.query?.code, 4000),
        cleanText(req.query?.state, 200)
      );
      done(true, `${ctx.google.connectedEmail()} 계정으로 연결되었습니다. 설정 화면으로 돌아가 주세요.`);
    } catch (err) {
      console.error('[orders] Google 로그인 실패', err);
      done(false, err instanceof Error ? err.message : 'Google 로그인에 실패했습니다.');
    }
  });

  router.delete('/google', requireMaster, async (_req, res) => {
    await ctx.google.signOut();
    res.json(ctx.google.view());
  });

  router.get('/sheets/links', requireMaster, (_req, res) => {
    res.json({ links: ctx.sheets.list(), ocrConfigured: isOcrConfigured() });
  });

  router.post('/sheets/preview', requireMaster, async (req, res) => {
    try {
      const sheets = await ctx.sheets.fetchSheets(cleanText(req.body?.url, 500));
      const constructionType = cleanText(req.body?.constructionType, 40);
      res.json({
        sheets: sheets.map(({ name, table }) => {
          const mapping = detectMapping(table.headers, table.rows);
          return {
            siteType: name,
            headers: table.headers,
            mapping,
            rows: buildDrafts({
              table,
              mapping,
              defaultConstructionType: constructionType,
              knownTypes: ctx.settings.constructionTypes(),
              siteType: name,
            }).slice(0, 20),
            warnings: table.warnings,
          };
        }),
      });
    } catch (err) {
      fail(err, res);
    }
  });

  router.post('/sheets/links', requireMaster, async (req, res) => {
    try {
      const link = await ctx.sheets.save({
        ...req.body,
        mapping: req.body?.mapping ? readMapping(req.body.mapping) : undefined,
      });
      res.status(201).json({ link, links: ctx.sheets.list() });
    } catch (err) {
      fail(err, res);
    }
  });

  /** 최근 동기화 기록 — 무엇을 받았고 무엇을 뺐는지. */
  router.get('/sheets/reports', requireMaster, async (_req, res) => {
    try {
      res.json({ reports: await ctx.sheets.reports() });
    } catch (err) {
      fail(err, res);
    }
  });

  router.post('/sheets/links/:id/sync', requireMaster, async (req, res) => {
    try {
      const { summary, report } = await ctx.sheets.sync(req.params.id);
      res.json({ summary, report, links: ctx.sheets.list(), reports: await ctx.sheets.reports() });
    } catch (err) {
      fail(err, res);
    }
  });

  router.post('/sheets/links/:id/enabled', requireMaster, async (req, res) => {
    try {
      const link = await ctx.sheets.setEnabled(req.params.id, Boolean(req.body?.enabled));
      res.json({ link, links: ctx.sheets.list() });
    } catch (err) {
      fail(err, res);
    }
  });

  router.delete('/sheets/links/:id', requireMaster, async (req, res) => {
    try {
      await ctx.sheets.remove(req.params.id);
      res.json({ links: ctx.sheets.list() });
    } catch (err) {
      fail(err, res);
    }
  });

  return router;
}

export { GoogleSheetService };
