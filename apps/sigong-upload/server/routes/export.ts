import { Router } from 'express';
import { requireManager } from '../auth';
import { buildWorkbook, type SheetColumn } from '../xlsx-writer';
import { cleanText } from '../util';
import type { AppContext } from '../context';
import type { SiteRecord, UploadLog } from '../../src/types';
import type { ManualAuditEntry } from '../manual-audit';

/**
 * 화면에 보이는 목록을 그대로 엑셀로 내보냅니다.
 *
 * 브라우저가 이미 걸러 놓은 줄을 그대로 받아서 씁니다. 서버가 필터를 다시
 * 적용하는 편이 요청은 가볍지만, 그러면 두 곳의 필터 구현이 조금씩 어긋날 때
 * "화면에는 12건인데 파일은 14건"이 됩니다. 받은 것을 그대로 쓰면 그런 일이
 * 구조적으로 생기지 않습니다.
 */

const MAX_ROWS = 5000;

function sheetDate(value: string): string {
  return (value || '').slice(0, 10);
}

/** 로컬 시각으로 "2026-08-31 14:05". ISO 문자열은 사람이 읽기 나쁩니다. */
function stamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function bytes(value: number): string {
  if (!value) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const SITE_COLUMNS: Array<SheetColumn<SiteRecord>> = [
  { header: '현장 ID', value: (site) => site.id, width: 26 },
  { header: '시공일', value: (site) => sheetDate(site.constructionDate), width: 12 },
  { header: '시공종류', value: (site) => site.constructionType, width: 12 },
  { header: '현장종류', value: (site) => site.siteType ?? '', width: 18 },
  { header: '주문자', value: (site) => site.customerName ?? '', width: 12 },
  { header: '시공기사', value: (site) => site.managerName, width: 20 },
  { header: '현장주소', value: (site) => site.address, width: 46 },
  { header: '사진', value: (site) => site.files.filter((f) => f.fileType === 'image').length, width: 8 },
  { header: '동영상', value: (site) => site.files.filter((f) => f.fileType === 'video').length, width: 8 },
  { header: '저장 상태', value: (site) => STATUS_LABELS[site.status] ?? site.status, width: 12 },
  { header: '저장 경로', value: (site) => site.folderPath, width: 46 },
  { header: '특이사항', value: (site) => site.notes, width: 34 },
  { header: '제출 시각', value: (site) => stamp(site.createdAt), width: 18 },
];

const STATUS_LABELS: Record<string, string> = {
  QUEUED: '대기', PROCESSING: '저장 중', COMPLETED: '저장 완료',
  PARTIAL: '일부 실패', FAILED: '실패',
};

const LOG_COLUMNS: Array<SheetColumn<UploadLog>> = [
  { header: '기록 시각', value: (log) => stamp(log.at), width: 18 },
  { header: '결과', value: (log) => ({ SUCCESS: '성공', PARTIAL: '일부 실패', FAILED: '실패' }[log.result] ?? log.result), width: 10 },
  { header: '현장 ID', value: (log) => log.siteId, width: 26 },
  { header: '시공종류', value: (log) => log.constructionType, width: 12 },
  { header: '시공기사', value: (log) => log.managerName, width: 20 },
  { header: '현장주소', value: (log) => log.address, width: 46 },
  { header: '파일 수', value: (log) => log.fileCount, width: 9 },
  { header: '용량', value: (log) => bytes(log.totalBytes), width: 12 },
  { header: '소요(초)', value: (log) => (log.durationMs ? Math.round(log.durationMs / 100) / 10 : ''), width: 10 },
  { header: '저장 모드', value: (log) => (log.mode === 'LIVE' ? 'SharePoint' : '테스트'), width: 12 },
  { header: '저장 경로', value: (log) => log.folderPath, width: 46 },
  { header: '내용', value: (log) => log.message, width: 50 },
  { header: '오류', value: (log) => (log.errors || []).join(' / '), width: 40 },
  { header: '요청 IP', value: (log) => log.clientIp, width: 16 },
];

const AUDIT_COLUMNS: Array<SheetColumn<ManualAuditEntry>> = [
  { header: '시각', value: (entry) => stamp(entry.at), width: 18 },
  {
    header: '동작',
    value: (entry) =>
      ({ ADDED: '직접 추가', DELETED: '직접 삭제', RENAMED: '이름 정리' })[entry.action] ?? entry.action,
    width: 12,
  },
  { header: '파일', value: (entry) => entry.name, width: 40 },
  { header: '경로', value: (entry) => entry.path, width: 60 },
  { header: '작업자', value: (entry) => entry.by || '확인되지 않음', width: 18 },
  { header: '내용', value: (entry) => entry.note, width: 44 },
  { header: '항목 ID', value: (entry) => entry.itemId, width: 30 },
];

export function createExportRouter(_ctx: AppContext): Router {
  const router = Router();

  const send = (res: any, fileName: string, body: Buffer) => {
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    // 한글 파일 이름은 filename* 로 보내야 브라우저가 깨뜨리지 않습니다.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );
    res.send(body);
  };

  router.post('/sites', requireManager, (req, res) => {
    const rows = (Array.isArray(req.body?.rows) ? req.body.rows : []).slice(0, MAX_ROWS) as SiteRecord[];
    const caption = cleanText(req.body?.caption, 200);
    send(
      res,
      `시공현황_${new Date().toISOString().slice(0, 10)}.xlsx`,
      buildWorkbook({
        sheetName: '시공현황',
        caption: caption || `시공현황 · ${rows.length}건`,
        columns: SITE_COLUMNS,
        rows,
      })
    );
  });

  router.post('/logs', requireManager, (req, res) => {
    const rows = (Array.isArray(req.body?.rows) ? req.body.rows : []).slice(0, MAX_ROWS) as UploadLog[];
    const caption = cleanText(req.body?.caption, 200);
    send(
      res,
      `업로드로그_${new Date().toISOString().slice(0, 10)}.xlsx`,
      buildWorkbook({
        sheetName: '업로드 로그',
        caption: caption || `업로드 로그 · ${rows.length}건`,
        columns: LOG_COLUMNS,
        rows,
      })
    );
  });

  router.post('/manual-audit', requireManager, async (req, res) => {
    const { readManualAudit } = await import('../manual-audit');
    const all = await readManualAudit(MAX_ROWS);
    const from = cleanText(req.body?.from, 10);
    const to = cleanText(req.body?.to, 10);
    const rows = all.filter((entry) => {
      const day = entry.at.slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    });

    send(
      res,
      `수동변경기록_${new Date().toISOString().slice(0, 10)}.xlsx`,
      buildWorkbook({
        sheetName: '수동 변경 기록',
        caption:
          `앱을 거치지 않은 SharePoint 변경 ${rows.length}건` +
          (from || to ? ` · ${from || '처음'}~${to || '지금'}` : ''),
        columns: AUDIT_COLUMNS,
        rows,
      })
    );
  });

  return router;
}
