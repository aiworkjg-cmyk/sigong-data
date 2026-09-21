import crypto from 'crypto';
import { buildDrafts, cancelReason, detectMapping, EMPTY_MAPPING } from './order-import';
import { parseCsv, toTable } from './spreadsheet';
import type { WorkbookSheet } from './spreadsheet';
import { serviceAccountEmail } from './google-service-account';
import { cleanText } from './util';
import type { SettingsRepository } from './repositories';
import type { WorkOrderService } from './work-orders';
import type {
  GoogleSheetLink,
  SheetSyncReport,
  WorkOrderColumnMap,
  WorkOrderDraft,
} from '../src/types';

const LINKS_KEY = 'googleSheetLinks';
const REPORTS_KEY = 'googleSheetSyncReports';
/** 남기는 동기화 기록 수. 조회는 최근 것만 보면 충분합니다. */
const MAX_REPORTS = 50;
/** 기록 한 건에 담는 근거 줄 수. */
const MAX_SAMPLES = 40;
const MAX_LINKS = 10;
const FETCH_TIMEOUT_MS = 20_000;
/** A published sheet is text; anything this large is not an order sheet. */
const MAX_BYTES = 8 * 1024 * 1024;

export class GoogleSheetError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'GoogleSheetError';
  }
}

/**
 * 구글시트 실시간 연동.
 *
 * 서비스 계정이나 OAuth 없이, 시트의 CSV 내보내기 주소를 주기적으로 읽습니다.
 * 이 선택이 중요한 이유: Google API 자격 증명을 붙이면 관리자가 또 한 번
 * 클라우드 콘솔을 거쳐야 하고, 이 앱은 이미 Azure 등록 한 번으로 충분히
 * 지쳤습니다. 시트를 "링크가 있는 모든 사용자 - 뷰어"로 공유하면 그 주소만으로
 * 읽히고, 관리자가 할 일은 주소를 붙여넣는 것뿐입니다.
 *
 * 대신 한계가 있습니다 — 비공개 시트는 읽지 못합니다. 그 경우 화면에 공유 설정을
 * 바꾸라고 안내합니다.
 */
export class GoogleSheetService {
  private links: GoogleSheetLink[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Stops a slow sync from being started again by the next tick. */
  private running = false;

  constructor(
    private readonly repo: SettingsRepository,
    private readonly orders: WorkOrderService,
    private readonly knownTypes: () => string[],
    /** 탭 이름을 그 시공종류의 현장종류 선택값으로 반영합니다. */
    private readonly registerSiteTypes: (constructionType: string, names: string[]) => Promise<void>
      = async () => {},
    /** 연결된 구글 계정의 토큰. 없으면 빈 문자열 — 공개 경로로 넘어갑니다. */
    private readonly googleToken: () => Promise<string> = async () => ''
  ) {}

  async load(): Promise<void> {
    const raw = await this.repo.get(LINKS_KEY);
    try {
      const parsed = raw ? JSON.parse(raw) : [];
      this.links = Array.isArray(parsed) ? parsed.filter((link) => link?.id && link?.url) : [];
    } catch {
      this.links = [];
    }
  }

  list(): GoogleSheetLink[] {
    return this.links.map((link) => ({ ...link }));
  }

  /* ---------------------------------------------------------------- */
  /* 주소                                                               */
  /* ---------------------------------------------------------------- */

  /**
   * 붙여넣은 시트 주소를 CSV 내보내기 주소로 바꿉니다.
   *
   * 사람이 복사해 오는 주소는 /edit#gid=0 이거나 /edit?usp=sharing 이거나
   * 이미 /export 형태이기도 합니다. 어느 쪽을 붙여넣어도 되게 여기서 흡수합니다.
   */
  static toCsvUrl(input: string): string {
    let parsed: URL;
    try {
      parsed = new URL(input.trim());
    } catch {
      throw new GoogleSheetError('올바른 주소가 아닙니다. 구글시트 링크를 그대로 붙여넣어 주세요.');
    }
    if (parsed.protocol !== 'https:' || !/(^|\.)google\.com$/i.test(parsed.hostname)) {
      throw new GoogleSheetError('구글시트 주소가 아닙니다. docs.google.com 으로 시작하는 링크를 붙여넣어 주세요.');
    }

    const id = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(parsed.pathname)?.[1];
    if (!id) throw new GoogleSheetError('시트 ID를 찾지 못했습니다. 브라우저 주소창의 링크를 그대로 붙여넣어 주세요.');

    // The tab is in the fragment on an /edit link and in the query on an export
    // link; missing it means the first tab, which is the right default.
    const gid =
      /[#&?]gid=(\d+)/.exec(parsed.hash || '')?.[1] ??
      parsed.searchParams.get('gid') ??
      '0';

    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${encodeURIComponent(gid)}`;
  }

  /** 시트를 읽어볼 주소들. 앞에서부터 되는 것을 씁니다. */
  static candidateUrls(
    input: string,
    signedIn = false
  ): Array<{ label: string; href: string; authorized?: boolean }> {
    const csv = GoogleSheetService.toCsvUrl(input);
    const id = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(csv)![1];
    const gid = new URL(csv).searchParams.get('gid') || '0';

    return [
      // 계정이 연결돼 있으면 이 경로가 가장 먼저이자 대개 유일하게 성공합니다.
      ...(signedIn
        ? [{
            label: '구글 계정',
            href:
              `https://docs.google.com/spreadsheets/d/${id}/export` +
              `?format=csv&gid=${encodeURIComponent(gid)}`,
            authorized: true,
          }]
        : []),
      { label: '링크 공유(csv)', href: csv },
      {
        label: '웹에 게시(gviz)',
        href:
          `https://docs.google.com/spreadsheets/d/${id}/gviz/tq` +
          `?tqx=out:csv&gid=${encodeURIComponent(gid)}`,
      },
    ];
  }

  async save(input: Partial<GoogleSheetLink>): Promise<GoogleSheetLink> {
    const url = String(input.url || '').trim();
    if (!url) throw new GoogleSheetError('구글시트 주소를 입력해 주세요.');
    GoogleSheetService.toCsvUrl(url);

    const id = String(input.id || '').trim() || `sheet-${crypto.randomBytes(5).toString('hex')}`;
    const existing = this.links.find((link) => link.id === id);

    // 같은 문서를 두 번 등록하는 것만 막습니다.
    //
    // 한 업체가 시트를 여러 장 쓰는 것은 정상입니다(백조1 · 백조2). 하지만
    // 같은 문서를 탭만 바꿔 두 번 넣는 것은 다릅니다 — 인증된 연동은 문서의
    // 모든 탭을 읽으므로, 두 연동이 완전히 같은 주문을 가져오게 됩니다.
    const documentId = GoogleSheetService.spreadsheetId(url);
    const twin = this.links.find((link) => {
      if (link.id === id) return false;
      try {
        return GoogleSheetService.spreadsheetId(link.url) === documentId;
      } catch {
        return false;
      }
    });
    if (twin) {
      throw new GoogleSheetError(
        `이 시트는 이미 "${twin.label}" 로 연동돼 있습니다. ` +
          '탭이 여러 개라면 연동 하나가 모든 탭을 함께 읽으므로 따로 등록하지 않아도 됩니다.'
      );
    }
    if (!existing && this.links.length >= MAX_LINKS) {
      throw new GoogleSheetError(`연동 시트는 최대 ${MAX_LINKS}개까지 등록할 수 있습니다.`);
    }

    // 업체(시공종류)를 반드시 지정하게 합니다.
    //
    // 업체마다 자기 시트를 따로 연동하는 구조이고, 시트에는 대개 자기 업체
    // 이름이 적혀 있지 않습니다("롯데백화점(흥주부)" 는 현장이지 업체가 아닙니다).
    // 비워 두면 그 시트에서 들어온 주문이 어느 업체 것인지 알 수 없게 되고,
    // 업체 관리자의 조회 범위도 정할 수 없습니다.
    const constructionType = cleanText(input.constructionType ?? existing?.constructionType, 40);
    if (!constructionType) {
      throw new GoogleSheetError('이 시트가 어느 업체(시공종류)의 주문인지 골라 주세요.');
    }

    const link: GoogleSheetLink = {
      id,
      label: cleanText(input.label ?? existing?.label, 60) || '구글시트',
      url,
      constructionType,
      mapping: { ...EMPTY_MAPPING, ...(existing?.mapping ?? {}), ...(input.mapping ?? {}) },
      // Clamped rather than rejected: a 1-minute poll on a shared sheet is a
      // request every minute forever, and nobody enters that on purpose.
      intervalMinutes: Math.min(Math.max(Number(input.intervalMinutes ?? existing?.intervalMinutes ?? 10), 0), 1440),
      enabled: input.enabled ?? existing?.enabled ?? true,
      lastSyncedAt: existing?.lastSyncedAt,
      lastResult: existing?.lastResult,
    };

    this.links = existing
      ? this.links.map((entry) => (entry.id === id ? link : entry))
      : [...this.links, link];
    await this.persist();
    return { ...link };
  }

  /**
   * 자동 동기화를 켜고 끕니다.
   *
   * 연동 자체를 지우는 것과 다릅니다 — 시트 주소·업체·열 연결을 그대로 두고
   * 주기적인 읽기만 멈춥니다. 시트를 정리하는 동안 잘못된 데이터가 밀려드는
   * 것을 막을 때 쓰고, 정리가 끝나면 다시 켜면 됩니다.
   */
  async setEnabled(id: string, enabled: boolean): Promise<GoogleSheetLink> {
    const link = this.links.find((entry) => entry.id === id);
    if (!link) throw new GoogleSheetError('등록되지 않은 시트입니다.', 404);
    this.links = this.links.map((entry) => (entry.id === id ? { ...entry, enabled } : entry));
    await this.persist();
    return { ...this.links.find((entry) => entry.id === id)! };
  }

  async remove(id: string): Promise<void> {
    if (!this.links.some((link) => link.id === id)) {
      throw new GoogleSheetError('등록되지 않은 시트입니다.', 404);
    }
    this.links = this.links.filter((link) => link.id !== id);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.repo.set(LINKS_KEY, JSON.stringify(this.links));
  }

  /* ---------------------------------------------------------------- */
  /* 동기화                                                             */
  /* ---------------------------------------------------------------- */

  /** 시트 주소에서 문서 ID만 뽑습니다. */
  static spreadsheetId(input: string): string {
    return /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(GoogleSheetService.toCsvUrl(input))![1]!;
  }

  /**
   * 인증된 상태에서 시트 전체를 탭 단위로 읽습니다.
   *
   * CSV 내보내기는 탭 하나만 가져옵니다. 주문서는 거래처별로 탭을 나눠 쓰고 그
   * 탭 이름이 곧 현장종류이므로, 엑셀 업로드와 같은 결과를 내려면 Sheets API 로
   * 전체를 읽어야 합니다. 엑셀과 구글시트가 다르게 동작하면 그 자체가 버그입니다.
   */
  private async fetchAllTabs(url: string, token: string): Promise<WorkbookSheet[]> {
    const id = GoogleSheetService.spreadsheetId(url);
    const headers = { Authorization: `Bearer ${token}` };

    const meta = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?fields=sheets.properties(title,hidden)`,
      { headers }
    );
    if (!meta.ok) {
      const detail = (await meta.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new GoogleSheetError(
        meta.status === 403 || meta.status === 404
          ? '이 시트를 읽을 권한이 없습니다. 구글시트에서 [공유] 를 누르고 ' +
            (serviceAccountEmail() || '연결된 계정 주소') +
            ' 를 뷰어로 추가한 뒤 다시 시도해 주세요.'
          : detail.error?.message || `시트 정보를 읽지 못했습니다 (HTTP ${meta.status}).`,
        502
      );
    }

    const properties = ((await meta.json()) as {
      sheets?: Array<{ properties?: { title?: string; hidden?: boolean } }>;
    }).sheets ?? [];
    const titles = properties
      .map((entry) => entry.properties)
      .filter((entry): entry is { title: string; hidden?: boolean } => Boolean(entry?.title))
      // 숨긴 탭은 대개 계산용입니다. 주문 목록이 아닙니다.
      .filter((entry) => !entry.hidden)
      .map((entry) => entry.title);

    const sheets: WorkbookSheet[] = [];
    for (const title of titles) {
      // FORMATTED_VALUE — 화면에 보이는 그대로 받습니다. 날짜가 일련번호가 아니라
      // "26.05.25" 로 오므로 엑셀 경로와 같은 파서를 그대로 쓸 수 있습니다.
      const values = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/` +
          `${encodeURIComponent(`'${title.replace(/'/g, "''")}'`)}` +
          '?valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING',
        { headers }
      );
      if (!values.ok) continue;

      const grid = ((await values.json()) as { values?: string[][] }).values ?? [];
      sheets.push({ name: title, table: toTable(grid) });
    }

    if (sheets.length === 0) throw new GoogleSheetError('시트에서 읽을 탭을 찾지 못했습니다.', 502);
    return sheets;
  }

  /** Reads the sheet without storing anything — used by the 미리보기 button. */
  /**
   * 시트를 탭 단위로 읽습니다.
   *
   * 인증돼 있으면 모든 탭을, 아니면 CSV 로 첫 탭만 가져옵니다. 어느 쪽이든
   * 엑셀 업로드와 같은 모양이라, 뒤쪽 파이프라인은 출처를 구분하지 않습니다.
   */
  async fetchSheets(url: string): Promise<WorkbookSheet[]> {
    const token = await this.googleToken();
    if (token) return this.fetchAllTabs(url, token);
    // 이름을 알 방법이 없으므로 탭 이름은 비워 둡니다 — 화면에서 채울 수 있습니다.
    return [{ name: '', table: await this.fetchTable(url) }];
  }

  async fetchTable(url: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      // 두 가지 주소를 차례로 시도합니다.
      //
      // /export 는 시트가 "링크가 있는 모든 사용자"로 공개돼야 열립니다.
      // 그런데 회사 계정(Workspace)은 대개 그 옵션을 조직 내부로 제한해 두고,
      // 그러면 익명 요청은 로그인 페이지를 받습니다 — 관리자는 분명히 공유를
      // 했는데도 계속 실패하는 것처럼 보입니다.
      //
      // gviz/tq 는 "웹에 게시"(파일 > 공유 > 웹에 게시)된 시트를 열어 줍니다.
      // 게시는 공유 정책과 별개로 동작하는 경우가 많아, 조직이 링크 공유를
      // 막아 둔 환경에서 유일하게 남는 무설정 경로입니다.
      const failures: string[] = [];

      // 구글 계정이 연결돼 있으면 그 사람 권한으로 먼저 읽습니다. 비공개 시트도
      // 열리므로 시트마다 공유 설정을 손댈 일이 없습니다.
      const token = await this.googleToken();
      const attempts = GoogleSheetService.candidateUrls(url, Boolean(token));

      for (const { label, href, authorized } of attempts) {
        const res = await fetch(href, {
          signal: controller.signal,
          redirect: 'follow',
          headers: authorized ? { Authorization: `Bearer ${token}` } : {},
        });
        const type = res.headers.get('content-type') || '';

        if (!res.ok) {
          failures.push(`${label}: HTTP ${res.status}`);
          continue;
        }
        // 공유되지 않은 시트는 200 과 함께 로그인 페이지를 돌려줍니다.
        // 상태 코드가 아니라 콘텐츠 형식이 유일하게 믿을 수 있는 신호입니다.
        if (/text\/html/i.test(type)) {
          failures.push(`${label}: 로그인 페이지가 반환됨`);
          continue;
        }

        const text = await res.text();
        if (text.length > MAX_BYTES) throw new GoogleSheetError('시트가 너무 큽니다.');
        return parseCsv(text);
      }

      const robot = serviceAccountEmail();
      throw new GoogleSheetError(
        [
          '시트를 읽지 못했습니다. 아래 중 하나만 해 주시면 됩니다.',
          robot
            ? `① (권장) 구글시트 [공유] 에 ${robot} 를 뷰어로 추가 — 한 번만 하면 됩니다.`
            : '① (권장) 이 화면 위의 [서비스 계정 키 등록] — 한 번 등록하면 만료 없이 계속 읽습니다.',
          '② 구글시트 [공유] > "링크가 있는 모든 사용자" > 뷰어 (탭이 여러 개면 첫 탭만 읽힙니다)',
          '③ 그 옵션이 조직 정책으로 막혀 있다면: [파일] > [공유] > [웹에 게시] > 게시',
          `(시도한 경로 — ${failures.join(' / ')})`,
        ].join('\n'),
        502
      );
    } catch (err: any) {
      if (err instanceof GoogleSheetError) throw err;
      throw new GoogleSheetError(
        err?.name === 'AbortError' ? '시트 응답 시간이 초과되었습니다.' : String(err?.message || err),
        502
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 시트 하나를 읽어 주문건으로 반영하고, 무엇을 받았고 무엇을 뺐는지 남깁니다.
   *
   * 자동 동기화에는 화면 확인 단계가 없습니다. 그래서 기록이 곧 확인 수단입니다 —
   * "왜 이 건이 목록에 없지"를 나중에 답할 수 있어야 합니다.
   */
  async sync(id: string): Promise<{ link: GoogleSheetLink; summary: string; report: SheetSyncReport }> {
    const link = this.links.find((entry) => entry.id === id);
    if (!link) throw new GoogleSheetError('등록되지 않은 시트입니다.', 404);

    const report: SheetSyncReport = {
      id: `sync-${Date.now().toString(36)}`,
      at: new Date().toISOString(),
      linkId: link.id,
      label: link.label,
      constructionType: link.constructionType,
      created: 0, updated: 0, unchanged: 0, excluded: 0, pending: 0, failed: 0,
      removed: 0,
      tabs: [],
      samples: [],
    };
    let summary: string;
    /** 이번 회차에 시트에서 확인한 건들. 여기 없는 저장분은 지웁니다. */
    const keptKeys: string[] = [];

    try {
      const sheets = await this.fetchSheets(link.url);
      const knownTypes = this.knownTypes();

      for (const { name, table } of sheets) {
        const mapping = link.mapping.address
          ? link.mapping
          : detectMapping(table.headers, table.rows);

        const drafts = buildDrafts({
          table,
          mapping,
          defaultConstructionType: link.constructionType,
          knownTypes,
          // 탭 이름이 현장종류입니다 — 엑셀 업로드와 같은 규칙.
          siteType: name,
        });

        for (const draft of drafts) {
          // 상태가 취소·시공완료·시공x — 받아오지 않습니다.
          if (draft.cancelled) {
            report.excluded += 1;
            this.sample(report, draft, `제외 — ${draft.statusText || '주문상태'}`);
            continue;
          }
          // 아직 채우다 만 줄은 오류가 아닙니다. 준비되지 않았을 뿐입니다.
          if (draft.problems.length > 0) {
            report.pending += 1;
            this.sample(report, draft, `대기 — ${draft.problems.join(' / ')}`);
          }
        }

        // 미완성 줄도 등록합니다. 값이 덜 채워졌을 뿐 실재하는 주문이고,
        // 빼 두면 기사가 현장에 가서도 목록에서 찾지 못합니다. 대신 무엇이
        // 비었는지 표식을 남겨 화면에서 눈에 띄게 합니다.
        const ready = drafts
          .filter((draft) => !draft.cancelled)
          .map((draft) =>
            draft.problems.length > 0 ? { ...draft, incomplete: draft.problems.join(' / ') } : draft
          );
        const result = await this.orders.importDrafts({
          drafts: ready,
          source: 'GOOGLE_SHEET',
          createdBy: `sheet:${link.label}`,
          knownTypes,
          overwriteEdited: false,
          // 이 건을 어느 연동이 가져왔는지. 같은 업체에 시트가 여럿일 때
          // 삭제 범위를 가르는 값입니다 — removeMissing 참고.
          sourceLinkId: link.id,
        });
        keptKeys.push(...(result.keys ?? []));
        report.created += result.created;
        report.updated += result.updated;
        report.unchanged += result.unchanged;
        report.failed += result.failed.length;
        // 시트(탭)별 내역. 한 연동에 탭이 여러 개일 때 어느 탭에서 무엇이
        // 들어왔는지 알 수 있어야 합니다.
        // 사유별로 세어 둡니다. 개수만으로는 "151건 제외"가 맞는 숫자인지
        // 알 수 없지만, "시공완료 120 · 취소 31" 이면 판단할 수 있습니다.
        const tally = (values: string[]) =>
          [...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>())]
            .map(([reason, count]) => ({ reason, count }))
            .sort((left, right) => right.count - left.count);

        const cancelledRows = drafts.filter((draft) => draft.cancelled);
        const pendingRows = drafts.filter((draft) => draft.problems.length > 0 && !draft.cancelled);

        report.tabs.push({
          name,
          // drafts.length 는 머리글을 뺀 그 탭의 전체 줄 수입니다.
          total: drafts.length,
          created: result.created,
          updated: result.updated,
          unchanged: result.unchanged,
          excluded: cancelledRows.length,
          pending: pendingRows.length,
          // skipped·failed 를 빼먹어 합이 총 항목과 맞지 않던 것을 바로잡습니다.
          skipped: result.skipped,
          failed: result.failed.length,
          reasons: tally(
            cancelledRows.map((draft) => cancelReason(draft.statusText ?? '') || '기타')
          ),
          pendingReasons: tally(pendingRows.flatMap((draft) => draft.problems)),
        });
      }

      // 시트에서 사라진 건을 지웁니다.
      //
      // 주문서가 원본이고 여기는 사본입니다 — 시트에서 지운 줄이나 통째로
      // 없앤 탭이 화면에 남아 있으면 기사가 없는 현장을 보게 됩니다. 제출이
      // 끝난 건은 남습니다(WorkOrderService.removeMissing).
      //
      // 모든 탭을 정상적으로 읽었을 때만 합니다. 한 탭이라도 실패한 회차에
      // 지우면, 못 읽은 탭의 주문이 통째로 사라집니다.
      if (report.failed === 0) {
        // 한 업체가 시트를 여러 장 쓸 수 있습니다 (백조1 · 백조2 · 백조 10월…).
        // 그럴 때는 이 연동이 가져온 건만 정리합니다. 시트가 이 하나뿐이면
        // 범위를 넓혀, 예전에 등록됐거나 해제된 연동이 남긴 건도 함께 치웁니다.
        const sole =
          this.links.filter((entry) => entry.constructionType === link.constructionType).length <= 1;
        report.removed = await this.orders.removeMissing({
          constructionType: link.constructionType,
          source: 'GOOGLE_SHEET',
          keys: keptKeys,
          linkId: sole ? undefined : link.id,
        });
      }

      // 탭 이름이 곧 현장종류입니다. 시트에 탭이 늘면 선택값도 따라 늘어야
      // 관리자가 설정 화면을 다시 열지 않아도 됩니다.
      await this.registerSiteTypes(
        link.constructionType,
        sheets.map(({ name }) => name)
      ).catch((err) => console.error('[sheet] 현장종류 반영 실패', err));

      // 삭제도 변동입니다 — 지운 것만 있는 회차를 "변동 사항 없음"으로
      // 적으면 사라진 건이 어디서 없어졌는지 추적할 기록이 남지 않습니다.
      const touched = report.created + report.updated + (report.removed ?? 0);
      summary = touched
        ? (sheets.length > 1 ? `탭 ${sheets.length}개 · ` : '') +
          `신규등록 ${report.created}건, 갱신 ${report.updated}건` +
          (report.removed ? `, 시트에서 삭제 ${report.removed}건` : '') +
          (report.excluded ? `, 제외 ${report.excluded}건` : '') +
          (report.pending ? `, 미완성 ${report.pending}줄` : '') +
          (report.failed ? `, 실패 ${report.failed}건` : '')
        // 변동이 없을 때는 숫자를 늘어놓지 않습니다. 알아야 할 것은 하나뿐입니다.
        : '변동 사항 없음';
    } catch (err) {
      summary = `실패 — ${err instanceof Error ? err.message : '알 수 없는 오류'}`;
      report.error = summary;
      await this.saveReport(report);
      await this.record(link.id, summary);
      throw err;
    }

    // 바뀐 것이 없으면 기록을 남기지 않습니다. 10분마다 도는 동기화가 매번
    // "0건" 을 적으면 목록이 그것만으로 가득 차고, 정작 무언가 들어온 회차를
    // 찾을 수 없게 됩니다. 실패는 위 catch 에서 언제나 남깁니다.
    const changed = report.created > 0 || report.updated > 0;
    if (changed) await this.saveReport(report);

    const refreshed = await this.record(link.id, summary);
    return { link: refreshed, summary, report };
  }

  /** 뺀 줄의 근거를 몇 개만 남깁니다. 원본 사본을 만들 생각은 없습니다. */
  private sample(report: SheetSyncReport, draft: WorkOrderDraft, reason: string): void {
    if (report.samples.length >= MAX_SAMPLES) return;
    report.samples.push({
      reason,
      siteType: draft.siteType,
      address: draft.address,
      customerName: draft.customerName,
      statusText: (draft.statusText || '').slice(0, 120),
    });
  }

  /** 최근 동기화 기록. 오래된 것부터 버립니다. */
  async reports(): Promise<SheetSyncReport[]> {
    try {
      const raw = await this.repo.get(REPORTS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async saveReport(report: SheetSyncReport): Promise<void> {
    try {
      const all = [report, ...(await this.reports())].slice(0, MAX_REPORTS);
      await this.repo.set(REPORTS_KEY, JSON.stringify(all));
    } catch (err) {
      console.error('[sheet] 동기화 기록 저장 실패', err);
    }
  }

  private async record(id: string, summary: string): Promise<GoogleSheetLink> {
    const at = new Date().toISOString();
    this.links = this.links.map((link) =>
      link.id === id ? { ...link, lastSyncedAt: at, lastResult: summary } : link
    );
    await this.persist();
    return { ...this.links.find((link) => link.id === id)! };
  }

  /* ---------------------------------------------------------------- */
  /* 자동 동기화                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Ticks once a minute and syncs whichever links are due.
   *
   * One shared timer rather than one per link: the interval is per-link but the
   * work is not worth a scheduler, and a single tick makes it impossible for
   * two syncs of the same sheet to overlap.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      for (const link of this.links) {
        if (!link.enabled || link.intervalMinutes <= 0) continue;
        const last = link.lastSyncedAt ? new Date(link.lastSyncedAt).getTime() : 0;
        if (now - last < link.intervalMinutes * 60_000) continue;
        try {
          await this.sync(link.id);
        } catch (err) {
          // Already recorded on the link itself; the log line is for operators.
          console.error(`[sheet] ${link.label} 동기화 실패`, err);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
