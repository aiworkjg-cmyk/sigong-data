import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  FileSpreadsheet,
  Image as ImageIcon,
  Link2,
  LogIn,
  LogOut,
  ShieldCheck,
  Loader2,
  PauseCircle,
  Pencil,
  PlayCircle,
  Plus,
  RefreshCw,
  Search,
  CalendarDays,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import { adminApi } from '../api';
import { isMaster, normalizeRegionGroup, REGION_GROUPS } from '../types';
import type {
  AdminSession,
  GoogleAccountView,
  GoogleSheetLink,
  SheetSyncReport,
  WorkOrder,
  WorkOrderColumnMap,
  WorkOrderDraft,
  WorkOrderImportPreview,
} from '../types';

interface AdminWorkOrdersProps {
  session: AdminSession;
  constructionTypes: string[];
}

/** 화면에서 연결할 수 있는 항목과 그 이름. */
const MAPPABLE: Array<{ field: keyof WorkOrderColumnMap; label: string; required?: boolean }> = [
  { field: 'constructionType', label: '시공종류' },
  { field: 'scheduledDate', label: '시공예정일' },
  { field: 'address', label: '주소' },
  { field: 'customerName', label: '주문자' },
  { field: 'orderNumber', label: '주문번호' },
  { field: 'phone', label: '연락처' },
  { field: 'notes', label: '비고' },
  { field: 'status', label: '주문상태 (취소 제외용)' },
];

const EDITABLE: Array<{ field: keyof WorkOrderDraft; label: string; width: string }> = [
  { field: 'scheduledDate', label: '시공예정일', width: 'w-32' },
  { field: 'address', label: '주소', width: 'min-w-[240px]' },
  { field: 'customerName', label: '주문자', width: 'w-28' },
  { field: 'phone', label: '연락처', width: 'w-32' },
  { field: 'orderNumber', label: '주문번호', width: 'w-28' },
];

/**
 * 주문서 관리.
 *
 * 어떤 경로로 들어오든 — 엑셀, 이미지, 구글시트 — 마지막 단계는 같습니다:
 * 표를 화면에서 확인하고 등록합니다. 확인 단계를 공유하는 것이 이 화면의
 * 설계입니다. OCR은 값을 틀리게 읽고, 열 연결은 빗나가며, 시트에는 아직
 * 채우다 만 줄이 있습니다. 그것들을 저장 뒤에 발견하면 기사가 찾지 못하는
 * 시공건이 생기고, 아무도 그 사실을 모릅니다.
 */
export const AdminWorkOrders: React.FC<AdminWorkOrdersProps> = ({ session, constructionTypes }) => {
  const master = isMaster(session.role);
  const allowedTypes = useMemo(
    () => (master ? constructionTypes : session.constructionTypes),
    [master, constructionTypes, session.constructionTypes]
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // 등록된 목록
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [filterType, setFilterType] = useState('');
  const [filterStatus, setFilterStatus] = useState<'OPEN' | 'SUBMITTED' | 'CANCELLED' | ''>('OPEN');
  const [search, setSearch] = useState('');
  /** 필터는 서로 중첩됩니다 — 시공종류 ∩ 기사 ∩ 지역 ∩ 날짜. */
  const [filterTechnician, setFilterTechnician] = useState('');
  const [filterRegion, setFilterRegion] = useState('');
  const [filterDate, setFilterDate] = useState('');

  // 불러온 주문서 (등록 전)
  const [preview, setPreview] = useState<WorkOrderImportPreview | null>(null);
  /** 여러 시트 중 지금 확인하고 있는 것. 주문서는 거래처별로 시트를 나눠 씁니다. */
  const [activeSheet, setActiveSheet] = useState(0);
  /** 원본 표. 열 연결을 바꿀 때 파일을 다시 올리지 않기 위해 시트별로 들고 있습니다. */
  const [rawRows, setRawRows] = useState<Record<number, string[][]>>({});
  const [importType, setImportType] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  // 구글시트
  const [links, setLinks] = useState<GoogleSheetLink[]>([]);
  const [ocrConfigured, setOcrConfigured] = useState(true);
  const EMPTY_SHEET = { id: '', label: '', url: '', constructionType: '', intervalMinutes: 10 };
  const [sheetDraft, setSheetDraft] = useState(EMPTY_SHEET);
  /** 입력창은 기본으로 닫혀 있습니다 — 추가는 가끔 하는 일입니다. */
  const [sheetFormOpen, setSheetFormOpen] = useState(false);
  const [google, setGoogle] = useState<GoogleAccountView | null>(null);
  /** 최근 동기화 기록 — 무엇을 받았고 무엇을 뺐는지. */
  const [reports, setReports] = useState<SheetSyncReport[]>([]);
  const [openReport, setOpenReport] = useState<string | null>(null);

  /** 그 시트의 동기화 기록만. 기록은 시트 카드 안에 붙어 있어야 의미가 읽힙니다. */
  const linkReports = (linkId: string) => reports.filter((report) => report.linkId === linkId);

  const ok = (text: string) => setFeedback({ kind: 'ok', text });
  const fail = (text: string) => setFeedback({ kind: 'error', text });

  const loadOrders = useCallback(async () => {
    try {
      // 날짜·기사·지역은 화면에서 거릅니다. 캘린더가 한 달치 밀도를 보여 주려면
      // 날짜로 좁히지 않은 집합이 필요하고, 같은 집합을 아래 목록도 써야
      // 캘린더에서 5건이라고 한 날을 눌렀을 때 목록에도 5건이 나옵니다.
      const page = await adminApi.workOrders({
        constructionType: filterType || undefined,
        status: filterStatus || undefined,
        search: search.trim() || undefined,
        limit: 500,
      });
      setOrders(page.items);
    } catch (err: any) {
      fail(err?.message || '시공건 목록을 불러오지 못했습니다.');
    }
  }, [filterType, filterStatus, search]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  useEffect(() => {
    if (!master) return;
    void (async () => {
      try {
        const [result, account, history] = await Promise.all([
          adminApi.sheetLinks(),
          adminApi.googleAccount(),
          adminApi.sheetReports(),
        ]);
        setLinks(result.links);
        setOcrConfigured(result.ocrConfigured);
        setGoogle(account);
        setReports(history.reports);
      } catch {
        // 연동 목록은 부가 기능입니다. 실패해도 주문서 등록은 그대로 됩니다.
      }
    })();
  }, [master]);

  /** 화면에서 거른 결과. 캘린더와 목록이 이것을 함께 씁니다. */
  const visibleOrders = useMemo(
    () =>
      orders.filter((order) => {
        if (filterTechnician && !(order.technicianName || '').includes(filterTechnician)) return false;
        if (filterRegion && normalizeRegionGroup(order.regionGroup) !== filterRegion) return false;
        if (filterDate && order.scheduledDate !== filterDate) return false;
        return true;
      }),
    [orders, filterTechnician, filterRegion, filterDate]
  );

  /** 주문서에 실제로 등장한 기사 이름. 목록에 없는 이름은 고를 이유가 없습니다. */
  const technicianOptions = useMemo(
    () =>
      [...new Set(orders.map((order) => order.technicianName).filter(Boolean))].sort((a, b) =>
        String(a).localeCompare(String(b), 'ko')
      ) as string[],
    [orders]
  );

  /* ---------------------------------------------------------------- */
  /* 주문서 불러오기                                                    */
  /* ---------------------------------------------------------------- */

  const handleFile = async (file: File) => {
    setBusy('preview');
    setFeedback(null);
    try {
      const result = await adminApi.previewWorkOrderFile(file, importType);
      setPreview(result);
      setActiveSheet(0);
      // 표 원본을 헤더 순서대로 되살려 둡니다 — 열 연결을 바꿀 때 씁니다.
      const restored: Record<number, string[][]> = {};
      result.sheets.forEach((sheet, index) => {
        restored[index] = sheet.rows.map((row) =>
          sheet.headers.map((header) => {
            const extra = row.extras.find((entry) => entry.label === header);
            if (extra) return extra.value;
            // status 는 Draft 에 같은 이름의 필드가 없습니다 — 원문은 statusText 에 있습니다.
            const mapped = (Object.keys(sheet.mapping) as Array<keyof WorkOrderColumnMap>).find(
              (field) => sheet.mapping[field] === header
            );
            if (!mapped) return '';
            if (mapped === 'status') return row.statusText ?? '';
            return String((row as unknown as Record<string, unknown>)[mapped] ?? '');
          })
        );
      });
      setRawRows(restored);

      const total = result.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
      const bad = result.sheets.reduce(
        (sum, sheet) => sum + sheet.rows.filter((row) => row.problems.length > 0).length,
        0
      );
      ok(
        `시트 ${result.sheets.length}개에서 ${total}줄을 읽었습니다.` +
          (bad ? ` 그중 ${bad}줄은 확인이 필요합니다.` : ' 모두 등록할 수 있습니다.')
      );
    } catch (err: any) {
      fail(err?.message || '주문서를 읽지 못했습니다.');
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const sheet = preview?.sheets[activeSheet] ?? null;

  /** 지금 보고 있는 시트만 갈아끼웁니다. 다른 시트의 확인 상태는 그대로 둡니다. */
  const patchSheet = (patch: Partial<NonNullable<typeof sheet>>) => {
    if (!preview || !sheet) return;
    setPreview({
      ...preview,
      sheets: preview.sheets.map((entry, index) =>
        index === activeSheet ? { ...entry, ...patch } : entry
      ),
    });
  };

  const changeMapping = async (field: keyof WorkOrderColumnMap, header: string) => {
    if (!sheet) return;
    const mapping = { ...sheet.mapping, [field]: header };
    setBusy('remap');
    try {
      const { rows } = await adminApi.remapWorkOrders({
        headers: sheet.headers,
        rows: rawRows[activeSheet] ?? [],
        mapping,
        constructionType: importType,
        siteType: sheet.siteType,
      });
      patchSheet({ mapping, rows });
    } catch (err: any) {
      fail(err?.message || '열 연결을 바꾸지 못했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const editRow = (rowKey: string, field: keyof WorkOrderDraft, value: string) => {
    if (!sheet) return;
    patchSheet({
      rows: sheet.rows.map((row) => {
        if (row.rowKey !== rowKey) return row;
        // cancelled 는 문자열이 아니라 불리언입니다 — [되살리기] 는 빈 값을 보냅니다.
        const next = (field === 'cancelled'
          ? { ...row, cancelled: Boolean(value) }
          : { ...row, [field]: value }) as WorkOrderDraft;
        // 고치는 즉시 경고가 사라지도록, 그 줄의 문제를 다시 계산합니다.
        next.problems = row.problems.filter((problem) => {
          if (field === 'address') return !problem.includes('주소');
          if (field === 'scheduledDate') return !problem.includes('날짜') && !problem.includes('시공예정일');
          if (field === 'constructionType') return !problem.includes('시공종류');
          return true;
        });
        return next;
      }),
    });
  };

  const dropRow = (rowKey: string) => {
    if (!sheet) return;
    patchSheet({ rows: sheet.rows.filter((row) => row.rowKey !== rowKey) });
  };

  /** 등록은 시트 단위가 아니라 파일 전체를 한 번에 합니다. */
  const readyRows = useMemo(
    () =>
      (preview?.sheets ?? []).flatMap((entry) =>
        entry.rows.filter((row) => row.problems.length === 0 && !row.cancelled)
      ),
    [preview]
  );

  const handleImport = async () => {
    if (!preview || readyRows.length === 0) return;
    setBusy('import');
    try {
      const result = await adminApi.importWorkOrders(readyRows, preview.source);
      ok(
        `새로 ${result.created}건, 갱신 ${result.updated}건` +
          (result.skipped ? `, 건너뜀 ${result.skipped}건` : '') +
          (result.failed.length ? `, 실패 ${result.failed.length}건` : '')
      );
      setPreview(null);
      setRawRows({});
      await loadOrders();
    } catch (err: any) {
      fail(err?.message || '등록에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  /* ---------------------------------------------------------------- */
  /* 구글시트                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * 구글 계정 연결. Microsoft 로그인과 같은 팝업 방식입니다.
   *
   * 팝업이 닫히거나 완료를 알릴 때까지 서버에 물어봅니다 — 팝업의 결과를
   * 그대로 믿지 않는 이유는 브라우저 정책이 창 사이의 연결을 끊는 일이 있기
   * 때문이고, 어차피 진실은 서버가 계정을 저장했는지 여부입니다.
   */
  const connectGoogle = async () => {
    setBusy('google');
    setFeedback(null);
    try {
      const { url } = await adminApi.startGoogleSignIn();
      const popup = window.open(url, 'google-signin', 'width=520,height=680');
      if (!popup) {
        fail('팝업이 차단되었습니다. 이 사이트의 팝업을 허용한 뒤 다시 눌러 주세요.');
        return;
      }
      const deadline = Date.now() + 3 * 60_000;
      let account = google;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        account = await adminApi.googleAccount();
        if (account.account) break;
        if (popup.closed || Date.now() > deadline) break;
      }
      if (!popup.closed) popup.close();
      setGoogle(account);
      if (account?.account) ok(`${account.account.email} 계정을 연결했습니다. 이제 비공개 시트도 읽을 수 있습니다.`);
      else fail('Google 로그인이 완료되지 않았습니다.');
    } catch (err: any) {
      fail(err?.message || 'Google 로그인을 시작하지 못했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const disconnectGoogle = async () => {
    if (!window.confirm('연결된 Google 계정을 해제할까요? 비공개 시트는 더 이상 읽을 수 없습니다.')) return;
    try {
      setGoogle(await adminApi.signOutGoogle());
      ok('Google 계정 연결을 해제했습니다.');
    } catch (err: any) {
      fail(err?.message || '연결 해제에 실패했습니다.');
    }
  };

  const saveSheet = async () => {
    setBusy('sheet-save');
    try {
      const editing = Boolean(sheetDraft.id);
      const result = await adminApi.saveSheetLink(sheetDraft);
      setLinks(result.links);
      setSheetDraft(EMPTY_SHEET);
      setSheetFormOpen(false);
      ok(`${result.link.label} 시트를 ${editing ? '수정' : '연동'}했습니다.`);
    } catch (err: any) {
      fail(err?.message || '시트를 연동하지 못했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const toggleSheet = async (id: string, enabled: boolean) => {
    setBusy(`toggle-${id}`);
    try {
      const result = await adminApi.setSheetLinkEnabled(id, enabled);
      setLinks(result.links);
      ok(enabled ? '자동 동기화를 다시 시작합니다.' : '자동 동기화를 멈췄습니다. [지금 동기화]는 그대로 씁니다.');
    } catch (err: any) {
      fail(err?.message || '자동 동기화 설정을 바꾸지 못했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const syncSheet = async (id: string) => {
    setBusy(`sheet-${id}`);
    try {
      const result = await adminApi.syncSheetLink(id);
      setLinks(result.links);
      setReports(result.reports);
      setOpenReport(result.report.id);
      ok(result.summary);
      await loadOrders();
    } catch (err: any) {
      fail(err?.message || '동기화에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const removeSheet = async (id: string) => {
    if (!window.confirm('이 시트 연동을 해제할까요? 이미 등록된 시공건은 남습니다.')) return;
    try {
      setLinks((await adminApi.removeSheetLink(id)).links);
    } catch (err: any) {
      fail(err?.message || '연동 해제에 실패했습니다.');
    }
  };

  const changeOrderStatus = async (order: WorkOrder, status: WorkOrder['status']) => {
    // 취소는 되돌릴 수 있지만, 목록에서 사라지는 것은 눈에 띄는 변화라
    // 실수로 눌렀는지 한 번 묻습니다. 되살리기는 묻지 않습니다 — 되돌리는
    // 방향은 잃을 것이 없습니다.
    if (status === 'CANCELLED') {
      const label = order.building || order.address || order.customerName || order.id;
      const confirmed = window.confirm(
        `"${label}" 시공건을 취소할까요?\n\n` +
          '기사 목록에서 사라집니다. 기록이 지워지지는 않으며,\n' +
          '[취소] 필터에서 찾아 [다시 대기]로 되돌릴 수 있습니다.'
      );
      if (!confirmed) return;
    }

    setBusy(`order-${order.id}`);
    try {
      await adminApi.setWorkOrderStatus(order.id, status);
      await loadOrders();
    } catch (err: any) {
      fail(err?.message || '상태를 바꾸지 못했습니다.');
    } finally {
      setBusy(null);
    }
  };

  /* ---------------------------------------------------------------- */

  return (
    <div className="max-w-6xl mx-auto py-5 sm:py-8 px-3 sm:px-6">
      <div className="mb-5">
        <h2 className="text-lg sm:text-2xl font-extrabold text-slate-900 flex items-center gap-2">
          <ClipboardList className="w-5 h-5 sm:w-6 sm:h-6 text-blue-600 shrink-0" />
          주문서 · 시공현장 목록
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          주문서를 등록하면 기사는 목록에서 현장을 고르기만 하면 됩니다. 주소를 현장에서 다시
          타이핑하지 않으므로 같은 건물이 여러 표기로 저장되지 않습니다.
        </p>
      </div>

      {feedback && (
        <div
          className={`flex items-start gap-2 p-3 rounded-lg border text-xs mb-4 ${
            feedback.kind === 'error'
              ? 'bg-red-50 border-red-200 text-red-800'
              : 'bg-emerald-50 border-emerald-200 text-emerald-800'
          }`}
        >
          {feedback.kind === 'error' ? (
            <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          ) : (
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          )}
          <span className="flex-1 break-words">{feedback.text}</span>
          <button type="button" onClick={() => setFeedback(null)} aria-label="닫기">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* ===================== 구글시트 연동 ===================== */}
      {master && (
        <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 mb-4">
          <h3 className="text-base font-bold text-slate-900 mb-1 flex items-center gap-2">
            <Link2 className="w-4 h-4 text-blue-600" />
            구글시트 실시간 연동
          </h3>
          <p className="text-xs text-slate-500 mb-4">
            정한 주기마다 시트를 읽어 새 주문을 등록합니다. 화면에서 직접 고친 항목은 시트가
            덮어쓰지 않습니다.
          </p>

          {/* 계정을 연결하면 시트마다 공유 설정을 손댈 일이 없어집니다.
              조직이 링크 공유를 막아 둔 경우 사실상 유일한 방법이기도 합니다. */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 mb-4">
            {google?.serviceAccountEmail ? (
              /* 서비스 계정이 설정돼 있으면 인증은 이미 끝난 상태입니다.
                 남은 일은 시트를 이 주소로 공유하는 것 하나뿐이라, 화면이 할
                 일은 그 주소를 복사하기 쉽게 내놓는 것입니다. */
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0" />
                  <p className="text-sm font-bold text-slate-900">서비스 계정 연결됨</p>
                </div>
                <p className="text-[11px] text-slate-600 mb-2">
                  아래 주소를 구글시트 <strong>[공유]</strong> 에 <strong>뷰어</strong>로 추가하면
                  그 시트를 읽습니다. 조직이 &quot;링크가 있는 모든 사용자&quot; 공유를 막아 두었어도
                  이 방법은 됩니다.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="flex-1 min-w-[240px] px-2 py-1.5 rounded bg-white border border-slate-300 font-mono text-[11px] text-slate-700 break-all">
                    {google.serviceAccountEmail}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard
                        .writeText(google.serviceAccountEmail)
                        .then(() => ok('서비스 계정 주소를 복사했습니다. 구글시트 [공유]에 붙여넣어 주세요.'))
                        .catch(() => fail('클립보드 복사가 차단되었습니다. 주소를 직접 선택해 복사해 주세요.'));
                    }}
                    className="px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-[11px] font-bold text-slate-700"
                  >
                    복사
                  </button>
                </div>
              </div>
            ) : google?.account ? (
              <div className="flex flex-wrap items-center gap-3">
                <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0" />
                <div className="flex-1 min-w-[180px]">
                  <p className="text-sm font-bold text-slate-900">{google.account.email}</p>
                  <p className="text-[11px] text-slate-500">
                    연결됨 — 이 계정이 볼 수 있는 시트는 공유 설정 없이 읽습니다.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void disconnectGoogle()}
                  className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-600"
                >
                  <LogOut className="inline w-3.5 h-3.5 mr-1" />
                  연결 해제
                </button>
              </div>
            ) : (
              <>
                <p className="text-sm font-bold text-slate-900 mb-1">Google 계정 연결 (권장)</p>
                <p className="text-[11px] text-slate-600 mb-3">
                  한 번 로그인해 두면 <strong>시트마다 공유 설정을 바꿀 필요가 없습니다.</strong>{' '}
                  읽기 권한만 요청하며, 이 앱은 시트를 고칠 수 없습니다.
                </p>
                <p className="text-[11px] text-amber-700 mb-3">
                  개인 Gmail 계정으로 만든 앱은 동의 화면을 <strong>[외부]</strong>로 둘 수밖에 없고,
                  그 상태에서는 <strong>7일마다 다시 로그인</strong>해야 합니다. 그게 번거로우면
                  서버에 <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> 을 설정하는 쪽을 권합니다 —
                  만료도 재로그인도 없습니다.
                </p>
                <button
                  type="button"
                  onClick={() => void connectGoogle()}
                  disabled={busy === 'google' || !google?.configured}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold disabled:opacity-50"
                >
                  {busy === 'google' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogIn className="w-3.5 h-3.5" />}
                  Google 계정 연결
                </button>
                {google && !google.configured && (
                  <p className="mt-2 text-[11px] text-amber-700">
                    서버에 <code>GOOGLE_CLIENT_ID</code> / <code>GOOGLE_CLIENT_SECRET</code> 이 없어
                    로그인을 시작할 수 없습니다. 설정 전에는 시트를 <strong>[공유] &gt; 링크가 있는
                    모든 사용자 &gt; 뷰어</strong> 로 바꾸거나 <strong>[웹에 게시]</strong> 해 주세요.
                  </p>
                )}
                {google?.configured && (
                  <p className="mt-2 text-[11px] text-slate-500 break-all">
                    Google Cloud Console 의 승인된 리디렉션 URI:{' '}
                    <code className="px-1 py-0.5 rounded bg-white border border-slate-300">
                      {google.redirectUri}
                    </code>
                  </p>
                )}
              </>
            )}
          </div>

          {/* 업체별로 묶어 보여 줍니다. 업체마다 자기 시트를 따로 연동하는
              구조라, 어느 업체 것이 몇 개인지가 먼저 보여야 합니다. */}
          <div className="space-y-2 mb-4">
            {links
              .slice()
              .sort((a, b) => a.constructionType.localeCompare(b.constructionType, 'ko'))
              .map((link) => (
              <div key={link.id} className="rounded-xl border border-slate-200">
                <div className="flex flex-wrap items-center gap-2 p-3">
                <div className="flex-1 min-w-[220px]">
                  <p className="text-sm font-bold text-slate-900">
                    <span className="inline-block px-2 py-0.5 mr-2 rounded-md bg-blue-100 text-blue-800 text-[11px] font-bold align-middle">
                      {link.constructionType || '업체 미지정'}
                    </span>
                    {link.label}
                    <span className="ml-2 text-[11px] font-semibold text-slate-400">
                      {!link.enabled
                        ? '자동 중단됨'
                        : link.intervalMinutes > 0
                          ? `${link.intervalMinutes}분마다`
                          : '수동'}
                    </span>
                  </p>
                  <p className="text-[11px] truncate">
                    {link.lastSyncedAt ? (
                      <>
                        <span className="text-slate-400">
                          {new Date(link.lastSyncedAt).toLocaleString('ko-KR')}
                        </span>
                        {' · '}
                        {/* 변동이 없을 때는 숫자를 늘어놓지 않습니다 — 알아야 할
                            것은 "바뀐 게 없다" 하나뿐입니다. */}
                        <span
                          className={
                            link.lastResult === '변동 사항 없음'
                              ? 'text-slate-400'
                              : link.lastResult?.startsWith('실패')
                                ? 'font-semibold text-rose-700'
                                : 'font-semibold text-emerald-700'
                          }
                        >
                          {link.lastResult ?? ''}
                        </span>
                      </>
                    ) : (
                      <span className="text-slate-400">아직 동기화한 적이 없습니다.</span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void syncSheet(link.id)}
                  disabled={busy === `sheet-${link.id}`}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-blue-300 text-blue-700 text-xs font-bold disabled:opacity-50"
                >
                  {busy === `sheet-${link.id}` ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3.5 h-3.5" />
                  )}
                  지금 동기화
                </button>
                {/* 연동을 지우지 않고 주기적인 읽기만 멈춥니다. 시트를 정리하는
                    동안 잘못된 데이터가 밀려드는 것을 막을 때 씁니다. */}
                <button
                  type="button"
                  onClick={() => void toggleSheet(link.id, !link.enabled)}
                  disabled={busy === `toggle-${link.id}`}
                  className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-bold disabled:opacity-50 ${
                    link.enabled
                      ? 'border-slate-300 text-slate-600'
                      : 'border-amber-400 bg-amber-50 text-amber-800'
                  }`}
                >
                  {busy === `toggle-${link.id}` ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : link.enabled ? (
                    <PauseCircle className="w-3.5 h-3.5" />
                  ) : (
                    <PlayCircle className="w-3.5 h-3.5" />
                  )}
                  {link.enabled ? '자동 중단' : '자동 재개'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSheetDraft({
                      id: link.id,
                      label: link.label,
                      url: link.url,
                      constructionType: link.constructionType,
                      intervalMinutes: link.intervalMinutes,
                    });
                    setSheetFormOpen(true);
                  }}
                  className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg"
                  title="수정"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => void removeSheet(link.id)}
                  className="p-2 text-slate-500 hover:bg-red-50 hover:text-red-600 rounded-lg"
                  title="연동 해제"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                </div>

                {/* 그 시트의 동기화 기록. 별도 구역이 아니라 이 카드 안에 붙여
                    두어야 "무엇의 기록인지"를 따로 읽지 않아도 됩니다. */}
                {linkReports(link.id).length > 0 && (
                  <details className="border-t border-slate-100">
                    <summary className="cursor-pointer px-3 py-2 text-[11px] font-bold text-slate-500">
                      변동이 있었던 동기화 {linkReports(link.id).length}건 — 무엇을 받았고 무엇을 뺐는지
                    </summary>
                    <div className="px-3 pb-3 space-y-1.5">
                      {linkReports(link.id).slice(0, 10).map((report) => {
                        const open = openReport === report.id;
                        // 예전에 저장된 기록에는 tabs·samples 가 아예 없습니다.
                        // 화면이 그걸 그대로 읽다가 탭 전체가 흰 화면이 됐습니다 —
                        // 저장된 옛 데이터는 늘 "빠진 필드가 있다"고 보고 다뤄야 합니다.
                        const tabs = report.tabs ?? [];
                        const samples = report.samples ?? [];
                        return (
                          <div key={report.id} className="rounded-lg bg-slate-50">
                            <button
                              type="button"
                              onClick={() => setOpenReport(open ? null : report.id)}
                              className="w-full flex flex-wrap items-center gap-2 px-2.5 py-1.5 text-left"
                            >
                              <span className="text-[11px] text-slate-500">
                                {new Date(report.at).toLocaleString('ko-KR')}
                              </span>
                              {/* 시트별로 적습니다. 합계만 보면 "17건"이 어느
                                  시트에서 온 숫자인지 알 수 없어, 이상한 값을
                                  발견해도 어느 시트를 열어야 할지 모릅니다. */}
                              {tabs.length > 0 ? (
                                tabs.map((tab) => (
                                  <span key={tab.name} className="text-[11px] text-slate-600">
                                    <strong className="text-slate-800">{tab.name}</strong>
                                    <span className="ml-1 text-emerald-700">신규 {tab.created}</span>
                                    {tab.updated > 0 && (
                                      <span className="ml-1 text-blue-700">갱신 {tab.updated}</span>
                                    )}
                                    {tab.excluded > 0 && (
                                      <span className="ml-1 text-slate-500">제외 {tab.excluded}</span>
                                    )}
                                  </span>
                                ))
                              ) : (
                                <span className="text-[11px] font-bold text-emerald-700">
                                  신규등록 {report.created}건
                                </span>
                              )}
                              {(report.removed ?? 0) > 0 && (
                                <span className="text-[11px] text-rose-700">
                                  시트에서 삭제 {report.removed}
                                </span>
                              )}
                              {report.pending > 0 && (
                                <span className="text-[11px] text-amber-700">미완성 {report.pending}</span>
                              )}
                              {report.error && <span className="text-[11px] text-rose-700">실패</span>}
                              <ChevronDown
                                className={`ml-auto w-3.5 h-3.5 text-slate-400 ${open ? 'rotate-180' : ''}`}
                              />
                            </button>
                            {open && (
                              <div className="px-2.5 pb-2">
                                {report.error && (
                                  <p className="mb-1.5 text-[11px] text-rose-700">{report.error}</p>
                                )}

                                {/* 탭(시트)별 내역. 한 연동에 탭이 여러 개일 때
                                    어느 현장에서 무엇이 들어왔는지 보여 줍니다. */}
                                {/* 시트(탭)별 내역. 숫자가 맞는지 사람이 직접
                                    더해 볼 수 있어야 합니다 — 합이 총 항목과
                                    다르면 규칙이 어딘가 잘못 걸린 것입니다. */}
                                {tabs.length > 0 && (
                                  <div className="mb-2 overflow-x-auto">
                                    <table className="w-full text-[11px] border-collapse">
                                      <thead className="text-slate-500">
                                        <tr className="border-b border-slate-300">
                                          <th className="text-left py-1 pr-3 whitespace-nowrap">시트(현장종류)</th>
                                          <th className="text-left py-1 px-2 whitespace-nowrap">구분</th>
                                          <th className="text-left py-1 px-2">사유</th>
                                          <th className="text-right py-1 pl-2 whitespace-nowrap">건수</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {tabs.map((tab) => {
                                          // skipped·failed 까지 더해야 총 항목과 맞습니다.
                                          const accounted =
                                            tab.created + tab.updated + tab.unchanged +
                                            tab.excluded + tab.skipped + tab.failed;

                                          /*
                                           * 한 줄에 한 가지 사실만 담습니다.
                                           *
                                           * 예전에는 사유를 배지로 이어 붙였는데, 사유가
                                           * "6월 7일 고객님이 별도로 다른업체에 설치하셨습니다"
                                           * 처럼 문장이면 줄이 뭉개져 아무것도 읽을 수
                                           * 없었습니다. 세로로 길어지는 편이 낫습니다 —
                                           * 표는 아래로 늘어나도 읽히지만 옆으로 뭉개지면
                                           * 읽히지 않습니다.
                                           */
                                          const rows: Array<{
                                            group: string;
                                            reason: string;
                                            count: number;
                                            tone: string;
                                          }> = [
                                            { group: '신규등록', reason: '이번에 새로 들어온 건', count: tab.created, tone: 'text-emerald-700' },
                                            { group: '갱신', reason: '이미 있던 건의 값이 바뀜', count: tab.updated, tone: 'text-blue-700' },
                                            { group: '변동없음', reason: '이전 동기화와 같음', count: tab.unchanged, tone: 'text-slate-400' },
                                            ...tab.reasons.map((entry) => ({
                                              group: '제외', reason: entry.reason, count: entry.count, tone: 'text-slate-600',
                                            })),
                                            ...tab.pendingReasons.map((entry) => ({
                                              group: '미완성', reason: entry.reason, count: entry.count, tone: 'text-amber-700',
                                            })),
                                            { group: '건너뜀', reason: '중복이거나 이미 제출 완료', count: tab.skipped, tone: 'text-slate-400' },
                                            { group: '실패', reason: '저장 중 오류', count: tab.failed, tone: 'text-rose-700' },
                                          ].filter((row) => row.count > 0);

                                          return (
                                            <React.Fragment key={tab.name}>
                                              <tr className="border-t border-slate-300 bg-slate-50">
                                                <td className="py-1 pr-3 font-bold text-slate-800">
                                                  {tab.name || '(이름 없음)'}
                                                </td>
                                                <td className="py-1 px-2 font-semibold text-slate-500">총 항목</td>
                                                <td className="py-1 px-2 text-slate-400">
                                                  {accounted !== tab.total && (
                                                    <span className="font-bold text-rose-600">
                                                      분류 합계 {accounted} — 총 항목과 다릅니다
                                                    </span>
                                                  )}
                                                </td>
                                                <td className="py-1 pl-2 text-right font-bold text-slate-900">
                                                  {tab.total}
                                                </td>
                                              </tr>
                                              {rows.map((row) => (
                                                <tr
                                                  key={`${tab.name}-${row.group}-${row.reason}`}
                                                  className="border-t border-slate-100"
                                                >
                                                  <td />
                                                  <td className={`py-1 px-2 font-semibold whitespace-nowrap ${row.tone}`}>
                                                    {row.group}
                                                  </td>
                                                  <td className="py-1 px-2 text-slate-500 break-all">
                                                    {row.reason}
                                                  </td>
                                                  <td className={`py-1 pl-2 text-right font-bold ${row.tone}`}>
                                                    {row.count}
                                                  </td>
                                                </tr>
                                              ))}
                                            </React.Fragment>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                                {samples.length === 0 ? (
                                  <p className="text-[11px] text-slate-500">뺀 줄이 없습니다.</p>
                                ) : (
                                  <div className="overflow-x-auto">
                                    <table className="w-full text-[11px]">
                                      <thead className="text-slate-500">
                                        <tr>
                                          <th className="text-left py-1 pr-2 whitespace-nowrap">사유</th>
                                          <th className="text-left py-1 pr-2 whitespace-nowrap">주문자</th>
                                          <th className="text-left py-1">주소</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-200">
                                        {samples.map((sample, index) => (
                                          <tr key={index}>
                                            <td className="py-1 pr-2 text-slate-700">{sample.reason}</td>
                                            <td className="py-1 pr-2 text-slate-500 whitespace-nowrap">
                                              {sample.customerName}
                                            </td>
                                            <td className="py-1 text-slate-500">{sample.address}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                    <p className="mt-1 text-[10px] text-slate-400">
                                      근거는 최대 40줄까지 남깁니다. 전체는 원본 시트에서 확인해 주세요.
                                    </p>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </details>
                )}
              </div>
            ))}
            {links.length === 0 && (
              <p className="p-3 rounded-lg bg-slate-50 text-xs text-slate-500">연동된 시트가 없습니다.</p>
            )}
          </div>


          {/* 입력창은 눌러야 열립니다. 늘 펼쳐 두면 "지금 뭘 하는 화면인지"가
              흐려지고, 수정하러 왔다가 새로 추가해 버리는 일이 생깁니다. */}
          {!sheetFormOpen && (
            <button
              type="button"
              onClick={() => {
                setSheetDraft(EMPTY_SHEET);
                setSheetFormOpen(true);
              }}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-2 border-dashed border-blue-300 bg-blue-50/50 text-sm font-bold text-blue-700 hover:bg-blue-50"
            >
              <Plus className="w-4 h-4" />
              새 구글시트 연동하기
            </button>
          )}

          {sheetFormOpen && (
          <div className="rounded-xl border-2 border-blue-300 p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-bold text-slate-900">
                {sheetDraft.id ? '시트 연동 수정' : '새 구글시트 연동'}
              </p>
              <button
                type="button"
                onClick={() => {
                  setSheetDraft(EMPTY_SHEET);
                  setSheetFormOpen(false);
                }}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100"
                aria-label="닫기"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <label>
                <span className="block text-xs font-bold text-slate-700 mb-1.5">이름</span>
                <input
                  value={sheetDraft.label}
                  onChange={(event) => setSheetDraft({ ...sheetDraft, label: event.target.value })}
                  placeholder="예: 백조 9월 주문"
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm"
                />
              </label>
              <label>
                <span className="block text-xs font-bold text-slate-700 mb-1.5">
                  업체 (시공종류) <span className="text-rose-500">*</span>
                </span>
                <select
                  value={sheetDraft.constructionType}
                  onChange={(event) => setSheetDraft({ ...sheetDraft, constructionType: event.target.value })}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm"
                >
                  <option value="">— 업체를 골라 주세요 —</option>
                  {allowedTypes.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </label>
              <label className="sm:col-span-2">
                <span className="block text-xs font-bold text-slate-700 mb-1.5">구글시트 주소</span>
                <input
                  value={sheetDraft.url}
                  onChange={(event) => setSheetDraft({ ...sheetDraft, url: event.target.value })}
                  placeholder="https://docs.google.com/spreadsheets/d/.../edit#gid=0"
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-300 font-mono text-xs"
                />
              </label>
              <label>
                <span className="block text-xs font-bold text-slate-700 mb-1.5">
                  동기화 주기 (분) <span className="font-normal text-slate-400">0 = 수동</span>
                </span>
                <input
                  type="number"
                  min={0}
                  max={1440}
                  value={sheetDraft.intervalMinutes}
                  onChange={(event) =>
                    setSheetDraft({ ...sheetDraft, intervalMinutes: Number(event.target.value) })
                  }
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={() => void saveSheet()}
              disabled={busy === 'sheet-save' || !sheetDraft.url.trim()}
              className="mt-4 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-slate-800 text-white text-xs font-bold disabled:opacity-50"
            >
              {busy === 'sheet-save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              {sheetDraft.id ? '수정 저장' : '시트 연동'}
            </button>
          </div>
          )}
        </div>
      )}

      {/* ===================== 주문서 불러오기 (접이식) ===================== */}
      <details className="bg-white rounded-2xl border border-slate-200 mb-4 group">
        <summary className="flex items-center gap-2 cursor-pointer p-4 sm:p-6 text-base font-bold text-slate-900">
          <Upload className="w-4 h-4 text-slate-400" />
          주문서 파일로 불러오기
          <span className="ml-1 text-xs font-normal text-slate-400">엑셀 · CSV · 사진</span>
          <ChevronDown className="ml-auto w-4 h-4 text-slate-400 transition-transform group-open:rotate-180" />
        </summary>
        <div className="px-4 sm:px-6 pb-4 sm:pb-6 -mt-2">
        <h3 className="text-base font-bold text-slate-900 mb-1">주문서 불러오기</h3>
        <p className="text-xs text-slate-500 mb-4">
          엑셀(.xlsx) · CSV · 주문서 사진을 올리면 표로 읽어 드립니다.{' '}
          <strong>등록 전에 화면에서 확인</strong>하고 고칠 수 있습니다.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex-1 min-w-[180px]">
            <span className="block text-xs font-bold text-slate-700 mb-1.5">
              시공종류
              <span className="ml-1 font-normal text-slate-400">(파일에 열이 없을 때 적용)</span>
            </span>
            <select
              value={importType}
              onChange={(event) => setImportType(event.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm"
            >
              <option value="">파일의 시공종류 열 사용</option>
              {allowedTypes.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </label>

          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xlsm,.csv,.tsv,.txt,image/*,application/pdf"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
            }}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy === 'preview'}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold disabled:opacity-50"
          >
            {busy === 'preview' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            파일 선택
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1">
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" /> 엑셀 · CSV
          </span>
          <span className="inline-flex items-center gap-1">
            <ImageIcon className={`w-3.5 h-3.5 ${ocrConfigured ? 'text-blue-600' : 'text-slate-300'}`} />
            주문서 사진 {ocrConfigured ? '(OCR 사용 가능)' : '— OCR 미설정'}
          </span>
        </div>
        {!ocrConfigured && (
          <p className="mt-2 text-[11px] text-amber-700">
            사진에서 글자를 읽으려면 서버에 <code>AZURE_OCR_ENDPOINT</code> 와{' '}
            <code>AZURE_OCR_KEY</code> 가 필요합니다. (Azure 포털 &gt; AI Document Intelligence)
            설정 전에는 엑셀·CSV·구글시트만 쓸 수 있습니다.
          </p>
        )}
        </div>
      </details>

      {/* ===================== 확인 후 등록 ===================== */}
      {preview && (
        <div className="bg-white rounded-2xl border-2 border-blue-300 p-4 sm:p-6 mb-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 className="text-base font-bold text-slate-900">
              확인 후 등록
              <span className="ml-2 text-xs font-semibold text-slate-500">
                시트 {preview.sheets.length}개 · 전체 {readyRows.length}줄 등록 가능
              </span>
            </h3>
            <button
              type="button"
              onClick={() => { setPreview(null); setRawRows({}); }}
              className="px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-600"
            >
              취소
            </button>
          </div>

          {/* 시트 이름이 곧 현장종류입니다. 여러 장이면 한 장씩 확인하고,
              등록은 마지막에 파일 전체를 한 번에 합니다. */}
          {preview.sheets.length > 1 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {preview.sheets.map((entry, index) => {
                const bad = entry.rows.filter((row) => row.problems.length > 0).length;
                return (
                  <button
                    key={entry.siteType + index}
                    type="button"
                    onClick={() => setActiveSheet(index)}
                    className={`px-2.5 py-1.5 rounded-lg border text-xs font-bold ${
                      index === activeSheet
                        ? 'border-blue-500 bg-blue-600 text-white'
                        : 'border-slate-300 bg-white text-slate-600'
                    }`}
                  >
                    {entry.siteType || `시트 ${index + 1}`}
                    <span className={index === activeSheet ? 'ml-1 text-blue-100' : 'ml-1 text-slate-400'}>
                      {entry.rows.length}
                      {bad > 0 ? ` · 확인 ${bad}` : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {sheet && sheet.rows.some((row) => row.cancelled) && (
            <p className="mb-2 flex items-start gap-1.5 rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] text-slate-600">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-400" />
              <span>
                주문상태가 취소인 <strong>{sheet.rows.filter((row) => row.cancelled).length}줄</strong>은
                등록에서 빠집니다. 판단 근거는 <strong>{sheet.mapping.status || '(상태 열 없음)'}</strong> 열의
                내용입니다 — 위 [주문상태] 연결을 바꾸면 다시 계산됩니다.
              </span>
            </p>
          )}

          {sheet && (
            <p className="mb-2 text-[11px] text-slate-500">
              현장종류: <strong className="text-slate-800">{sheet.siteType || '(시트 이름 없음)'}</strong>
              <span className="ml-1 text-slate-400">— 폴더 규칙의 {'{siteType}'} 토큰으로 들어갑니다.</span>
            </p>
          )}

          {(sheet?.warnings ?? []).map((warning) => (
            <p key={warning} className="flex items-start gap-1.5 mb-2 text-[11px] text-amber-700">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {warning}
            </p>
          ))}

          {/* 열 연결 */}
          <div className="rounded-xl border border-slate-200 p-3 mb-4">
            <p className="text-xs font-bold text-slate-700 mb-2">열 연결</p>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
              {MAPPABLE.map(({ field, label, required }) => (
                <label key={field}>
                  <span className="block text-[11px] font-semibold text-slate-500 mb-1">
                    {label}
                    {required && <span className="text-rose-500"> *</span>}
                  </span>
                  <select
                    value={sheet?.mapping[field] ?? ''}
                    onChange={(event) => void changeMapping(field, event.target.value)}
                    disabled={busy === 'remap'}
                    className="w-full px-2 py-1.5 rounded-lg border border-slate-300 text-xs"
                  >
                    <option value="">— 사용 안 함 —</option>
                    {(sheet?.headers ?? []).map((header) => (
                      <option key={header} value={header}>{header}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </div>

          {/* 확인 표 */}
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-2 py-2 text-left font-bold text-slate-500 w-8" />
                  <th className="px-2 py-2 text-left font-bold text-slate-500 w-24">시공종류</th>
                  {EDITABLE.map(({ field, label }) => (
                    <th key={field} className="px-2 py-2 text-left font-bold text-slate-500">{label}</th>
                  ))}
                  <th className="px-2 py-2 w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(sheet?.rows ?? []).map((row) => {
                  const broken = row.problems.length > 0;
                  return (
                    <tr
                      key={row.rowKey}
                      className={
                        row.cancelled
                          ? 'bg-slate-100 text-slate-400 line-through'
                          : broken
                            ? 'bg-rose-50/50'
                            : row.duplicateOf
                              ? 'bg-amber-50/40'
                              : ''
                      }
                      title={row.cancelled ? `취소로 제외 — ${row.statusText ?? ''}` : undefined}
                    >
                      <td className="px-2 py-1.5 align-top pt-3">
                        {row.cancelled ? (
                          <X className="w-3.5 h-3.5 text-slate-400" />
                        ) : broken ? (
                          <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />
                        ) : row.duplicateOf ? (
                          <RefreshCw className="w-3.5 h-3.5 text-amber-500" />
                        ) : (
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <select
                          value={row.constructionType}
                          onChange={(event) => editRow(row.rowKey, 'constructionType', event.target.value)}
                          className="w-full px-1.5 py-1 rounded border border-slate-300 text-xs"
                        >
                          <option value="">선택</option>
                          {allowedTypes.map((type) => (
                            <option key={type} value={type}>{type}</option>
                          ))}
                        </select>
                      </td>
                      {EDITABLE.map(({ field, width }) => (
                        <td key={field} className="px-2 py-1.5">
                          <input
                            type={field === 'scheduledDate' ? 'date' : 'text'}
                            value={String(row[field] ?? '')}
                            onChange={(event) => editRow(row.rowKey, field, event.target.value)}
                            className={`${width} px-1.5 py-1 rounded border border-slate-300 text-xs`}
                          />
                        </td>
                      ))}
                      <td className="px-2 py-1.5 align-top pt-2 whitespace-nowrap">
                        {row.cancelled && (
                          <button
                            type="button"
                            onClick={() => editRow(row.rowKey, 'cancelled', '')}
                            className="mr-1 px-1.5 py-1 rounded border border-slate-300 text-[10px] font-bold text-slate-600"
                            title="취소가 아니라면 되살립니다"
                          >
                            되살리기
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => dropRow(row.rowKey)}
                          className="p-1 text-slate-400 hover:text-red-600"
                          title="이 줄 제외"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {(sheet?.rows ?? []).some((row) => row.problems.length > 0) && (
            <ul className="mt-2 space-y-0.5">
              {(sheet?.rows ?? [])
                .filter((row) => row.problems.length > 0)
                .slice(0, 8)
                .map((row) => (
                  <li key={row.rowKey} className="text-[11px] text-rose-700">
                    {row.rowKey}: {row.problems.join(' / ')}
                  </li>
                ))}
            </ul>
          )}

          {preview.extractedText && (
            <details className="mt-3">
              <summary className="cursor-pointer text-[11px] font-bold text-slate-500">
                이미지에서 읽은 원문 보기
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] text-slate-100 whitespace-pre-wrap">
                {preview.extractedText}
              </pre>
            </details>
          )}

          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={busy === 'import' || readyRows.length === 0}
            className="mt-4 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold disabled:opacity-50"
          >
            {busy === 'import' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            {readyRows.length}건 등록
          </button>
        </div>
      )}

      {/* 등록된 시공건 목록은 [시공건 관리] 탭으로 옮겼습니다.
          등록하는 일과 등록된 것을 관리하는 일은 서로 다른 작업이고,
          한 화면에 두면 주문서를 올리러 왔다가 목록을 스크롤해 내려가야
          합니다. 캘린더와 같은 탭에 있어야 "언제 무엇이 있는가"를 두 가지
          방식으로 같은 자리에서 볼 수 있습니다. */}
    </div>
  );
};
