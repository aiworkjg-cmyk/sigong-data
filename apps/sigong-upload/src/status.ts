import type { SiteStatus } from './types';

/**
 * One place for how each submission state is presented, so the list, the detail
 * page, and the submitter's confirmation screen never drift apart.
 */
export const SITE_STATUS_META: Record<
  SiteStatus,
  { label: string; short: string; className: string; inFlight: boolean }
> = {
  QUEUED: {
    label: '접수됨 · 저장 대기',
    short: '대기',
    className: 'bg-slate-100 text-slate-700 border-slate-200',
    inFlight: true,
  },
  PROCESSING: {
    label: '저장 처리 중',
    short: '처리 중',
    className: 'bg-blue-100 text-blue-800 border-blue-200',
    inFlight: true,
  },
  COMPLETED: {
    label: '저장 완료',
    short: '완료',
    className: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    inFlight: false,
  },
  PARTIAL: {
    label: '일부 저장 실패',
    short: '일부 실패',
    className: 'bg-amber-100 text-amber-800 border-amber-200',
    inFlight: false,
  },
  FAILED: {
    label: '저장 실패',
    short: '실패',
    className: 'bg-red-100 text-red-800 border-red-200',
    inFlight: false,
  },
};

export function statusMeta(status: SiteStatus) {
  return SITE_STATUS_META[status] ?? SITE_STATUS_META.QUEUED;
}
