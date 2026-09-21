import React, { useCallback, useEffect, useState } from 'react';
import { SubmissionOrderSettings } from './SubmissionOrderSettings';
import {
  Bell,
  Check,
  AlertTriangle,
  FolderTree,
  Info,
  Loader2,
  Mail,
  Pencil,
  Plus,
  RotateCcw,
  Star,
  Send,
  Settings,
  Trash2,
  X,
  XCircle,
  Building2,
  CheckCircle2,
  ChevronDown,
  Copy,
  ExternalLink,
  LogIn,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Tag,
} from 'lucide-react';
import { adminApi } from '../api';
import { isMaster } from '../types';
import type {
  AdminRole,
  ConstructionTypeConfig,
  MicrosoftAccountView,
  SharePointStorageTarget,
  TeamsWebhookProfile,
} from '../types';

interface NamedEntry {
  id: string;
  displayName: string;
}

interface AdminSettingsProps {
  role: AdminRole;
}

interface TokenInfo {
  token: string;
  label: string;
  sample: string;
}

/** Matches the server default so [기본값으로 되돌리기] needs no round trip. */
const DEFAULT_RULE = {
  root: '시공현장자료',
  segments: ['{type}', '{yyyy}', '{MM}월', '{MMdd}_{region}_{building}'],
};

/** 설정 화면의 구역. 알림과 도움말이 모두 이 단위로 붙습니다. */
type Scope = 'ms' | 'storage' | 'types' | 'rule' | 'webhook' | 'email';

interface HelpSection {
  title: string;
  body: Array<{ heading: string; lines: string[] }>;
}

/**
 * 각 설정의 사용법.
 *
 * 화면 밖 문서가 아니라 화면 안에 두는 이유: 이 설정들은 한 번 맞춰 놓으면
 * 몇 달 동안 손대지 않다가, 문제가 생겼을 때 처음 보는 사람이 열어 보게 됩니다.
 * 그때 필요한 건 "무엇을 넣는 칸인가"가 아니라 "왜 이렇게 되어 있고, 바꾸면
 * 무엇이 따라 바뀌는가" 입니다.
 */
const HELP: Record<Scope, HelpSection> = {
  ms: {
    title: 'Microsoft 업무 계정 — 사용법',
    body: [
      {
        heading: '무엇을 하는 설정인가',
        lines: [
          '팀 이름·채널 이름을 실제 SharePoint 저장 위치로 바꿔 주는 조회 권한을 얻는 곳입니다.',
          '로그인한 사람의 권한으로 조회하므로, 테넌트 관리자 동의 없이도 본인이 속한 팀은 찾을 수 있습니다.',
          '한 번 로그인하면 계정이 서버에 기억되어, 다음부터는 팀·채널 이름만 입력하면 됩니다.',
        ],
      },
      {
        heading: '처음 한 번만 필요한 준비',
        lines: [
          'Azure 포털 > 앱 등록 > [인증] > 플랫폼 추가 > 웹(Web) 을 고릅니다.',
          '화면에 표시된 리디렉션 URI를 [복사] 버튼으로 복사해 그대로 붙여넣고 저장합니다.',
          '한 글자라도 다르면 로그인이 거부됩니다. 끝의 / 나 http/https 차이도 포함입니다.',
          '등록된 주소가 하나도 없으면 AADSTS500113, 주소가 다르면 AADSTS50011 오류가 납니다.',
        ],
      },
      {
        heading: '비밀번호는 어디에 저장되나',
        lines: [
          '저장되지 않습니다. 비밀번호는 Microsoft 로그인 창에만 입력되고 이 앱은 보지 못합니다.',
          '앱이 보관하는 것은 갱신 토큰 하나이며, 관리자 세션 비밀키로 암호화해 저장합니다.',
          '[계정 연결 해제]를 누르면 즉시 삭제됩니다. 이미 저장된 연결 대상은 그대로 남습니다.',
        ],
      },
      {
        heading: '자주 겪는 문제',
        lines: [
          '"관리자만 동의할 수 있습니다" — 개별 사용자 동의가 막힌 테넌트입니다. 아래 관리자 동의 주소를 조직 IT 담당자에게 보내 1회 동의를 받으면 이후 모두에게 적용됩니다.',
          '팝업이 안 뜸 — 브라우저가 팝업을 차단했습니다. 주소창 오른쪽 차단 아이콘에서 허용해 주세요.',
          '로그인은 됐는데 팀을 못 찾음 — 그 계정이 해당 팀의 멤버가 아닌 경우입니다. 게스트나 관리자여도 멤버가 아니면 조회되지 않습니다.',
        ],
      },
    ],
  },

  storage: {
    title: 'Teams · SharePoint 저장 대상 — 사용법',
    body: [
      {
        heading: '무엇을 정하는가',
        lines: [
          '제출된 자료가 "어느 팀의 어느 채널"에 저장될지를 정합니다. 폴더 이름 규칙은 여기서 정하지 않습니다.',
          '여러 개를 저장해 두고 [선택 전환]으로 바꿔 쓸 수 있습니다. [현재 사용] 표시가 붙은 하나에만 실제로 저장됩니다.',
        ],
      },
      {
        heading: '연결하는 순서',
        lines: [
          '팀 이름 칸을 클릭하면 로그인한 계정이 속한 팀 목록이 자동으로 뜹니다. 골라 주세요.',
          '팀을 고르면 그 팀의 채널 목록이 채널 칸에 자동으로 채워집니다.',
          '[찾아서 연결 · 현재 사용]을 누르면 채널의 실제 SharePoint 위치를 읽어와 저장하고, 바로 현재 사용으로 지정합니다.',
          '목록에 없으면 이름을 직접 입력해도 됩니다. Teams 화면에 보이는 이름과 저장된 이름이 다를 수 있어 목록에서 고르는 쪽이 안전합니다.',
        ],
      },
      {
        heading: '연결이 잘 됐는지 확인하려면',
        lines: [
          '[테스트 이미지 업로드]를 누르면 실제 업로드와 똑같은 경로로 작은 PNG 한 장을 올려 봅니다.',
          '성공하면 저장된 경로와 SharePoint 링크가 표시됩니다. 파일은 채널 폴더 아래 _연결테스트 폴더에 남으므로 확인 후 지우셔도 됩니다.',
          '실패하면 조회 권한이 아니라 쓰기 권한 문제일 수 있습니다. 오류 메시지에 어느 쪽인지 나옵니다.',
        ],
      },
      {
        heading: '수정과 삭제',
        lines: [
          '연필 아이콘을 누르면 그 줄 바로 아래에서 이름과 ID를 고칠 수 있습니다.',
          '이 채널의 실제 SharePoint 폴더 값은 연결할 때 Microsoft에서 읽어 온 것을 그대로 유지합니다. 채널 이름을 바꿔도 폴더는 따라 바뀌지 않기 때문입니다.',
          '저장 위치 자체를 옮기려면 이름을 고치지 말고 위에서 팀·채널을 다시 연결해 주세요.',
          '이미 저장이 끝난 자료는 대상을 바꿔도 옮겨지지 않습니다. 다음 제출부터 새 위치에 저장됩니다.',
        ],
      },
    ],
  },

  types: {
    title: '시공종류별 입력 항목 · 폴더 규칙 — 사용법',
    body: [
      {
        heading: '두 가지 묶음으로 나뉩니다',
        lines: [
          '전용 규칙 — 그 시공종류만의 폴더 구조를 따로 지정해 둔 것입니다.',
          '공통 기본 규칙 사용 — 아래 [공통 기본 폴더 규칙]을 그대로 따르는 것입니다. 공통 규칙을 바꾸면 이쪽이 전부 함께 바뀝니다.',
          '버튼 안 회색 숫자는 그 시공종류에 추가된 입력 항목 개수입니다.',
        ],
      },
      {
        heading: '입력 항목 추가하기',
        lines: [
          '제출 화면에서 시공종류를 고른 뒤에 나타날 칸을 여기서 정합니다.',
          '직접 입력 — 자유롭게 타이핑. 검색 후 선택 — 미리 정해 둔 목록에서만 고르게 합니다.',
          '선택값이 폴더 이름이 되는 항목이라면 오타를 막을 수 있는 [검색 후 선택]을 권합니다.',
          '필수로 지정하면 값이 없을 때 제출이 막힙니다.',
        ],
      },
      {
        heading: '폴더 토큰이란',
        lines: [
          '입력받은 값을 폴더 이름 안에 끼워 넣는 자리표시자입니다. 항목 이름에서 자동으로 만들어집니다.',
          '예: 항목 이름을 "주문번호"로 하면 토큰은 주문번호가 되고, 폴더 단계에 {주문번호} 라고 쓰면 그 자리에 실제 입력값이 들어갑니다.',
          '토큰은 직접 고칠 수 있습니다. 단, 한 번 고친 뒤에는 항목 이름을 바꿔도 토큰이 따라 바뀌지 않습니다 — 이미 폴더 규칙에서 그 토큰을 쓰고 있을 수 있기 때문입니다.',
          '[폴더 단계에 추가] 버튼을 누르면 그 토큰이 아래 폴더 단계 맨 끝에 한 줄로 들어갑니다.',
          'type, region, date 처럼 시스템이 이미 쓰는 이름은 토큰으로 쓸 수 없습니다.',
        ],
      },
      {
        heading: '폴더 단계 쓰는 법',
        lines: [
          '한 줄이 폴더 한 단계입니다. 위에서 아래 순서대로 중첩됩니다.',
          '한 줄 안에서 토큰과 글자를 섞어도 됩니다. 예: {MMdd}_{region}_{building}',
          '값이 비어 있는 토큰은 앞뒤 구분기호(_)와 함께 자동으로 정리되므로 빈칸이 남지 않습니다.',
          '변경해도 이미 저장된 폴더는 옮겨지지 않습니다. 운영 중에 자주 바꾸면 같은 현장 자료가 여러 위치로 흩어집니다.',
        ],
      },
    ],
  },

  rule: {
    title: '공통 기본 폴더 규칙 — 사용법',
    body: [
      {
        heading: '어디에 적용되나',
        lines: [
          '전용 규칙을 따로 지정하지 않은 모든 시공종류에 적용됩니다.',
          '여기를 바꾸면 위 목록의 [공통 기본 규칙 사용] 쪽에 있는 시공종류가 전부 함께 바뀝니다.',
          '전용 규칙을 쓰는 시공종류는 영향을 받지 않습니다.',
        ],
      },
      {
        heading: '최상위 폴더',
        lines: [
          '채널 폴더 아래에 만들어지는 공통 시작점입니다. 예: 시공현장자료',
          '/ 로 여러 단계를 한 번에 지정할 수도 있습니다. 예: 2026년/시공현장자료',
        ],
      },
      {
        heading: '항목(토큰) 사용',
        lines: [
          '아래 항목 목록에서 버튼을 누르면 마지막 폴더 단계 칸 끝에 그 토큰이 붙습니다.',
          '항목 위에 마우스를 올리면 실제로 어떤 값이 들어가는지 예시가 보입니다.',
          '맨 위 검은 상자는 지금 설정으로 저장하면 나올 경로 미리보기입니다. 저장 전에 확인하세요.',
        ],
      },
      {
        heading: '주의',
        lines: [
          '규칙을 바꿔도 이미 저장된 폴더는 옮겨지지 않습니다. 다음 제출부터 적용됩니다.',
          '\\ : * ? " < > | 문자는 SharePoint가 폴더 이름으로 받지 않으므로 쓸 수 없습니다.',
          '[기본값] 버튼은 처음 제공되던 규칙으로 되돌립니다. 누른 뒤 [저장]까지 해야 실제로 적용됩니다.',
        ],
      },
    ],
  },

  webhook: {
    title: 'Teams 알림 — 사용법',
    body: [
      {
        heading: '언제 보내지나',
        lines: [
          '자료 제출이 끝나고 SharePoint에 실제로 저장된 것이 확인된 뒤에만 보냅니다.',
          '일부만 저장되거나 실패한 경우도 보냅니다. 카드 색과 파일 개수(예: 3/5)로 구분됩니다.',
          '저장된 알림 대상 전부에 전송됩니다. 팀별·채널별로 여러 개 등록해 두셔도 됩니다.',
        ],
      },
      {
        heading: '워크플로 주소 만들기',
        lines: [
          'Teams에서 알림을 받을 채널 이름 옆 ··· 을 누릅니다.',
          '[워크플로] > "웹후크 요청을 받으면 채널에 게시" 템플릿을 고릅니다.',
          '만들어진 주소를 복사해 아래 [Teams 워크플로 주소] 칸에 붙여넣습니다.',
          '주소는 로그인한 계정으로 조회되지 않습니다. Teams에서 직접 만들어 붙여넣어야 합니다.',
          '팀·채널 이름은 목록에서 고를 수 있습니다. 어느 채널로 가는 주소인지 나중에 알아보기 위한 이름표입니다.',
        ],
      },
      {
        heading: '저장 전에 반드시 테스트',
        lines: [
          '[테스트 카드 보내기]를 누르면 예시 카드가 실제로 그 채널에 갑니다.',
          '테스트와 저장은 같은 검사를 통과해야 하므로, 테스트가 되면 저장도 됩니다.',
          '주소가 Microsoft가 발급한 것이 아니면 거부되며, 오류 메시지에 실제 서버 이름이 표시됩니다.',
        ],
      },
      {
        heading: '카드 아래 "워크플로 템플릿을 사용해 보냈습니다" 문구 지우기',
        lines: [
          '그 줄은 이 앱이 보내는 내용이 아닙니다. 흐름(Flow)이 템플릿에서 만들어졌다는 사실 자체에 Teams가 붙이는 안내라, 흐름 안의 어떤 동작을 고쳐도 사라지지 않습니다.',
          '해결은 템플릿과의 연결을 끊는 것 하나뿐입니다: Power Automate(make.powerautomate.com) > 내 흐름 > 해당 흐름 > [다른 이름으로 저장] 으로 복사본을 만듭니다.',
          '복사본은 템플릿에서 생성된 것이 아니므로 문구가 붙지 않습니다. 복사본을 [켜기] 하고 원본은 끄세요.',
          '복사본은 웹후크 주소가 새로 발급됩니다. 트리거를 열어 새 주소를 복사한 뒤, 위 [Teams 워크플로 주소] 칸을 교체하고 [테스트 카드 보내기]로 확인하세요.',
          '흐름 안의 "Do Not Remove FlowIL" 동작은 건드리지 마세요. 이 문구의 원인이 아니며, 지우면 흐름이 깨집니다.',
        ],
      },
    ],
  },

  email: {
    title: '삭제 요청 수신 메일 — 사용법',
    body: [
      {
        heading: '무엇에 쓰이나',
        lines: [
          '업체 관리자는 시공기사를 직접 삭제할 수 없습니다. 삭제를 시도하면 여기 등록된 주소 전원에게 요청 메일이 갑니다.',
          '실제 삭제는 마스터관리자만 할 수 있습니다.',
          '요청 창에도 이 목록이 그대로 표시되어, 요청자가 누구에게 가는지 알 수 있습니다.',
        ],
      },
      {
        heading: '왜 여러 명인가',
        lines: [
          '요청을 처리할 수 있는 사람이 앱을 설정한 사람과 같지 않은 경우가 많습니다.',
          '주소가 하나뿐이면 그 사람이 자리를 비우거나 메일함을 안 보는 순간 요청이 조용히 사라집니다.',
        ],
      },
      {
        heading: '주의',
        lines: [
          '한 명도 등록하지 않으면 요청자에게 "마스터관리자에게 문의"라고만 안내되고 메일은 가지 않습니다.',
          '메일 발송에는 서버의 발신 메일 설정(MAIL_SENDER)이 필요합니다. 없으면 메일이 나가지 않습니다.',
        ],
      },
    ],
  },
};

/**
 * Mirrors the server's token derivation so the field card can show the name
 * that will actually be saved, rather than one the server then rewrites.
 * Korean letters are allowed on purpose — {주문번호} is the readable form.
 */
function tokenFromLabel(label: string): string {
  return label
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/^[-]+/, '')
    .slice(0, 30);
}

/**
 * 설정 — 마스터관리자 전용.
 *
 * Two things live here, both of which change where or how work lands:
 * the folder rule that decides the SharePoint path, and the addresses that
 * receive roster-deletion requests.
 */
export const AdminSettings: React.FC<AdminSettingsProps> = ({ role }) => {
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * The one result message on screen, and which section it belongs to.
   *
   * Scoped rather than page-level: the settings page is long enough that a
   * banner at the top is off-screen by the time you press a button near the
   * bottom, so the answer to "did that work?" appeared somewhere the user was
   * not looking. One at a time is deliberate — the newest result is the one
   * being waited on, and stale successes stacking up read as noise.
   */
  const [feedback, setFeedback] = useState<{ scope: Scope; kind: 'ok' | 'error'; text: string } | null>(null);
  /** Which section's 사용법 panel is expanded. */
  const [openHelp, setOpenHelp] = useState<Scope | null>(null);

  // 폴더 규칙
  const [root, setRoot] = useState('');
  const [segments, setSegments] = useState<string[]>([]);
  /** 전용 규칙이 없는 시공종류가 사용하는 공통 파일 이름입니다. */
  const [fileNameTemplate, setFileNameTemplate] = useState('');
  const [fileNameTokens, setFileNameTokens] = useState<
    { token: string; label: string; sample: string }[]
  >([]);
  const [savedRule, setSavedRule] = useState('');
  /** 관리자가 따로 보관해 둔 기본값. 없으면 null. */
  const [savedDefault, setSavedDefault] = useState<
    { root: string; segments: string[]; fileNameTemplate?: string } | null
  >(null);
  const [example, setExample] = useState('');
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [typeConfigs, setTypeConfigs] = useState<ConstructionTypeConfig[]>([]);
  const [selectedType, setSelectedType] = useState('');
  const [typeDraft, setTypeDraft] = useState<ConstructionTypeConfig | null>(null);
  const [storageStatus, setStorageStatus] = useState<Awaited<ReturnType<typeof adminApi.storageStatus>> | null>(null);
  /** 시공종류별 규칙에서 토큰을 넣을 단계. 공통 규칙과 같은 조작입니다. */
  const [typeSegment, setTypeSegment] = useState(0);

  const EMPTY_TARGET: SharePointStorageTarget = {
    id: '', accountEmail: '', teamName: '', channelName: '', teamId: '', channelId: '',
    siteId: '', driveId: '', channelFolder: '',
  };
  const [storageTargets, setStorageTargets] = useState<SharePointStorageTarget[]>([]);
  const [activeTargetId, setActiveTargetId] = useState('');
  // Which saved row is open for editing. Held separately from the draft so the
  // editor can render *inside that row* — the previous version filled a form
  // hidden inside a collapsed <details>, so pressing 수정 looked like nothing
  // happened at all.
  const [editingTargetId, setEditingTargetId] = useState<string | null>(null);
  const [storageTarget, setStorageTarget] = useState<SharePointStorageTarget>(EMPTY_TARGET);
  const [connectionDraft, setConnectionDraft] = useState({
    accountEmail: '', teamName: '', channelName: '',
  });
  const [testUpload, setTestUpload] = useState<{ remotePath: string; webUrl?: string } | null>(null);

  // Microsoft 업무 계정
  const [microsoft, setMicrosoft] = useState<MicrosoftAccountView | null>(null);
  const [copiedRedirect, setCopiedRedirect] = useState(false);
  const [teamOptions, setTeamOptions] = useState<NamedEntry[]>([]);
  const [channelOptions, setChannelOptions] = useState<NamedEntry[]>([]);
  /** Kept apart from channelOptions so the two team pickers cannot clobber each other. */
  const [webhookChannelOptions, setWebhookChannelOptions] = useState<NamedEntry[]>([]);

  // Teams 알림
  const EMPTY_WEBHOOK: TeamsWebhookProfile = { id: '', teamName: '', channelName: '', url: '' };
  const [webhooks, setWebhooks] = useState<TeamsWebhookProfile[]>([]);
  const [webhook, setWebhook] = useState<TeamsWebhookProfile>(EMPTY_WEBHOOK);

  // 삭제 요청 수신 메일
  const [emails, setEmails] = useState<string[]>([]);
  const [emailDraft, setEmailDraft] = useState('');
  const [editingEmail, setEditingEmail] = useState<string | null>(null);
  const [editEmailDraft, setEditEmailDraft] = useState('');

  const readOnly = !isMaster(role);
  useEffect(() => { if (!readOnly) void adminApi.storageStatus().then(setStorageStatus).catch(() => setStorageStatus(null)); }, [readOnly]);
  const currentRule = JSON.stringify({ root, segments });
  const isDirty = currentRule !== savedRule;

  /**
   * Whether a 시공종류 still files uploads the common way.
   *
   * Compared against the *saved* common rule rather than the on-screen draft,
   * so editing the common rule below does not silently reclassify every type
   * while the admin is still typing.
   */
  const usesDefaultRule = (entry: ConstructionTypeConfig) =>
    !entry.folderRule.fileNameTemplate && entry.folderRule.root === JSON.parse(savedRule || '{}').root &&
    JSON.stringify(entry.folderRule.segments) === JSON.stringify(JSON.parse(savedRule || '{}').segments);

  const say = (scope: Scope, kind: 'ok' | 'error', text: string) =>
    setFeedback({ scope, kind, text });

  /**
   * The result of the last action in this section, rendered where the button
   * that caused it is. Written as a function rather than a component so React
   * does not see a new component type on every render and remount the node.
   */
  const message = (scope: Scope) => {
    if (feedback?.scope !== scope) return null;
    const failed = feedback.kind === 'error';
    return (
      <div
        role="status"
        className={`flex items-start gap-2 p-3 rounded-lg border text-xs mb-3 ${
          failed
            ? 'bg-red-50 border-red-200 text-red-800'
            : 'bg-emerald-50 border-emerald-200 text-emerald-800'
        }`}
      >
        {failed ? <XCircle className="w-4 h-4 shrink-0 mt-0.5" /> : <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />}
        <span className="flex-1 break-words">{feedback.text}</span>
        <button type="button" onClick={() => setFeedback(null)} aria-label="닫기">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  };

  /** The ⓘ toggle that sits beside a section heading. */
  const helpButton = (scope: Scope) => (
    <button
      type="button"
      onClick={() => setOpenHelp(openHelp === scope ? null : scope)}
      aria-expanded={openHelp === scope}
      title="사용법 보기"
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-bold transition-colors ${
        openHelp === scope
          ? 'border-blue-400 bg-blue-600 text-white'
          : 'border-slate-300 text-slate-500 hover:border-blue-400 hover:text-blue-700'
      }`}
    >
      <Info className="w-3.5 h-3.5" />
      사용법
      <ChevronDown className={`w-3 h-3 transition-transform ${openHelp === scope ? 'rotate-180' : ''}`} />
    </button>
  );

  const helpPanel = (scope: Scope) => {
    if (openHelp !== scope) return null;
    const help = HELP[scope];
    return (
      <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50/50 p-4">
        <p className="text-sm font-bold text-slate-900 mb-3">{help.title}</p>
        <div className="space-y-3">
          {help.body.map((part) => (
            <div key={part.heading}>
              <p className="text-xs font-bold text-blue-900 mb-1">{part.heading}</p>
              <ul className="space-y-1">
                {part.lines.map((line) => (
                  <li key={line} className="flex gap-1.5 text-[11px] leading-relaxed text-slate-700">
                    <span className="text-blue-400 shrink-0">·</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    );
  };

  /**
   * "팀: 시공서비스 · 채널: 시공사진" as two stacked rows.
   *
   * One line ran the label and the value together in the same weight and
   * colour, so a channel called "03_시공" and the word "채널" read as one
   * string. Stacking them and colouring the value separately makes the actual
   * names the thing the eye lands on.
   */
  const teamChannelLabel = (teamName: string, channelName: string) => (
    <dl className="space-y-0.5">
      {([['팀', teamName], ['채널', channelName]] as const).map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-2">
          <dt className="w-8 shrink-0 text-[11px] font-semibold text-slate-400">{label}</dt>
          <dd className="text-sm font-bold text-slate-900 break-all">{value || '—'}</dd>
        </div>
      ))}
    </dl>
  );

  const load = useCallback(async () => {
    setFeedback(null);
    try {
      const [rule, mail, hook, typeResult, targetResult, account] = await Promise.all([
        adminApi.folderRule(),
        adminApi.deleteRequestEmails(),
        adminApi.teamsWebhook(),
        adminApi.constructionTypeConfigs(),
        adminApi.storageTargets(),
        adminApi.microsoftAccount(),
      ]);
      setRoot(rule.folderRule.root);
      setSegments(rule.folderRule.segments);
      setFileNameTemplate(rule.folderRule.fileNameTemplate ?? '');
      setFileNameTokens(rule.fileNameTokens ?? []);
      setSavedDefault(rule.savedDefault ?? null);
      setSavedRule(JSON.stringify(rule.folderRule));
      setExample(rule.example);
      setTokens(rule.availableTokens);
      setEmails(mail.deleteRequestEmails);
      setWebhooks(hook.webhooks);
      setTypeConfigs(typeResult.configs);
      const first = typeResult.configs[0];
      setSelectedType(first?.constructionType || '');
      setTypeDraft(first ? structuredClone(first) : null);
      setStorageTargets(targetResult.targets);
      setActiveTargetId(targetResult.activeTargetId);
      setMicrosoft(account);
    } catch (err: any) {
      say('storage', 'error', err?.message || '설정을 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /* ---------------------------------------------------------------- */
  /* 폴더 규칙                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 규칙의 토큰을 예시 값으로 바꿔 보여 줍니다.
   *
   * 서버에 물어보지 않고 화면에서 만듭니다 — 관리자가 규칙을 한 글자 고칠
   * 때마다 결과가 바로 보여야 하고, 그러려면 왕복이 없어야 합니다. 예시 값은
   * 서버가 토큰 목록과 함께 내려준 것이라 실제 치환과 어긋나지 않습니다.
   */
  const fillTokens = (template: string): string => {
    const table = new Map(
      [...tokens, ...fileNameTokens].map((entry) => [entry.token, entry.sample])
    );
    return template
      .replace(/\{[^}]+\}/g, (match) => table.get(match) ?? '')
      .replace(/[_-]{2,}/g, '_')
      .replace(/^[_-]+|[_-]+$/g, '');
  };

  /** 지금 저장된 규칙을 "우리 회사 기본값" 으로 보관합니다. */
  const handleSaveAsDefault = async () => {
    setBusy('rule-default');
    try {
      const result = await adminApi.setFolderRule({ root, segments, fileNameTemplate });
      setRoot(result.folderRule.root);
      setSegments(result.folderRule.segments);
      setFileNameTemplate(result.folderRule.fileNameTemplate ?? '');
      setSavedRule(JSON.stringify(result.folderRule));
      setExample(result.example);
      const { savedDefault: stored } = await adminApi.saveFolderRuleAsDefault();
      setSavedDefault(stored);
      say('rule', 'ok', '지금 설정을 기본값으로 저장했습니다. [기본값 불러오기]로 언제든 되돌릴 수 있습니다.');
    } catch (err: any) {
      say('rule', 'error', err?.message || '기본값 저장에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const handleSaveRule = async () => {
    setBusy('rule');
    setFeedback(null);
    try {
      const result = await adminApi.setFolderRule({ root, segments, fileNameTemplate });
      setRoot(result.folderRule.root);
      setSegments(result.folderRule.segments);
      setFileNameTemplate(result.folderRule.fileNameTemplate ?? '');
      setSavedRule(JSON.stringify(result.folderRule));
      setExample(result.example);
      say('rule', 'ok', '폴더·파일 이름 규칙을 저장했습니다. 다음 제출부터 적용됩니다.');
    } catch (err: any) {
      say('rule', 'error', err?.message || '폴더 규칙 저장에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const updateSegment = (index: number, value: string) =>
    setSegments(segments.map((segment, position) => (position === index ? value : segment)));

  const removeSegment = (index: number) =>
    setSegments(segments.filter((_, position) => position !== index));

  const insertToken = (index: number, token: string) =>
    updateSegment(index, `${segments[index] ?? ''}${token}`);

  /**
   * 토큰을 넣을 단계.
   *
   * 예전에는 늘 마지막 단계에 붙였습니다. 그래서 "2단계에 {현장종류}를 넣고
   * 싶다"는, 이 화면에서 가장 흔한 일이 불가능했습니다 — 마지막 칸에 들어간
   * 토큰을 잘라내 옮겨 적어야 했습니다. 칸을 누르면 그 칸이 대상이 됩니다.
   */
  const [activeSegment, setActiveSegment] = useState(0);

  const updateTypeSegment = (index: number, value: string) =>
    setTypeDraft((draft) =>
      draft
        ? {
            ...draft,
            folderRule: {
              ...draft.folderRule,
              segments: draft.folderRule.segments.map((segment, position) =>
                position === index ? value : segment
              ),
            },
          }
        : draft
    );

  const insertTypeToken = (index: number, token: string) =>
    setTypeDraft((draft) =>
      draft
        ? {
            ...draft,
            folderRule: {
              ...draft.folderRule,
              segments: draft.folderRule.segments.map((segment, position) =>
                position === index ? `${segment}${token}` : segment
              ),
            },
          }
        : draft
    );

  /* ---------------------------------------------------------------- */
  /* Microsoft 업무 계정                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Signs in as the administrator and remembers the account.
   *
   * A popup rather than a redirect: the 설정 화면 holds unsaved drafts — a
   * half-written folder rule, a webhook being pasted — and navigating the whole
   * tab away to Microsoft and back would discard every one of them.
   */
  const handleMicrosoftSignIn = async () => {
    setBusy('ms-signin');
    setFeedback(null);
    try {
      const { url } = await adminApi.startMicrosoftSignIn();
      const popup = window.open(url, 'microsoft-signin', 'width=520,height=680');
      if (!popup) {
        say('ms', 'error', '팝업이 차단되었습니다. 이 사이트의 팝업을 허용한 뒤 다시 눌러 주세요.');
        return;
      }

      // Two signals, neither of them trusted on its own. The callback page posts
      // back when it can, but browser COOP rules can sever window.opener across
      // the trip to Microsoft, and a popup the admin simply closed posts
      // nothing at all. So the authority is the server: poll it until it says
      // an account is remembered, and use the popup only to stop waiting early.
      const deadline = Date.now() + 3 * 60_000;
      let posted = false;
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        if (event.data?.source === 'sigong-microsoft') posted = true;
      };
      window.addEventListener('message', onMessage);

      let account = microsoft;
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          account = await adminApi.microsoftAccount();
          if (account.account) break;
          // Give a posted result or a closed window one more poll to land, then
          // stop rather than spinning for three minutes on an abandoned sign-in.
          if (posted || popup.closed) {
            await new Promise((resolve) => setTimeout(resolve, 1200));
            account = await adminApi.microsoftAccount();
            break;
          }
          if (Date.now() > deadline) break;
        }
      } finally {
        window.removeEventListener('message', onMessage);
        if (!popup.closed) popup.close();
      }

      setMicrosoft(account);
      if (account?.account) {
        say('ms', 'ok', 
          `${account.account.upn} 계정을 기억했습니다. 이제 팀 이름과 채널 이름만으로 연결할 수 있습니다.`
        );
      } else {
        say('ms', 'error', 'Microsoft 로그인이 완료되지 않았습니다. 로그인 창의 안내 메시지를 확인해 주세요.');
      }
    } catch (err: any) {
      say('ms', 'error', err?.message || 'Microsoft 로그인을 시작하지 못했습니다.');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Copies the redirect URI for pasting into Azure.
   *
   * Retyping it is the failure mode this is here to remove: the value must
   * match the app registration character for character, and a hand-typed
   * trailing slash or http/https slip produces AADSTS50011 — an error whose
   * text says nothing about which of the two strings is wrong.
   */
  const copyRedirectUri = async () => {
    if (!microsoft?.redirectUri) return;
    try {
      await navigator.clipboard.writeText(microsoft.redirectUri);
      setCopiedRedirect(true);
      window.setTimeout(() => setCopiedRedirect(false), 2000);
    } catch {
      say('ms', 'error', '클립보드 복사가 차단되었습니다. 주소를 직접 선택해 복사해 주세요.');
    }
  };

  const handleMicrosoftSignOut = async () => {
    if (!window.confirm('기억된 Microsoft 계정을 지울까요? 이미 저장된 대상은 그대로 유지됩니다.')) return;
    setBusy('ms-signout');
    try {
      setMicrosoft(await adminApi.signOutMicrosoft());
      setTeamOptions([]);
      setChannelOptions([]);
      say('ms', 'ok', '기억된 Microsoft 계정을 지웠습니다.');
    } catch (err: any) {
      say('ms', 'error', err?.message || '계정 연결 해제에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Loads the real team list so the admin picks rather than types.
   *
   * Failure here is deliberately silent: the manual name fields still work, and
   * an error banner about a convenience lookup would read as if the connection
   * itself had failed.
   */
  const loadTeamOptions = useCallback(async () => {
    try {
      const { teams } = await adminApi.microsoftTeams();
      setTeamOptions(teams);
    } catch {
      setTeamOptions([]);
    }
  }, []);

  const handlePickTeam = async (teamName: string) => {
    setConnectionDraft((draft) => ({ ...draft, teamName, channelName: '' }));
    setChannelOptions([]);
    const team = teamOptions.find((entry) => entry.displayName === teamName);
    if (!team) return;
    try {
      const { channels } = await adminApi.microsoftChannels(team.id);
      setChannelOptions(channels);
    } catch {
      setChannelOptions([]);
    }
  };

  const signedInUpn = microsoft?.account?.upn;
  useEffect(() => {
    if (signedInUpn) void loadTeamOptions();
  }, [signedInUpn, loadTeamOptions]);

  /* ---------------------------------------------------------------- */
  /* 저장 대상                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Same team → channel lookup as the connect form, for the 알림 대상 fields.
   *
   * The webhook URL itself cannot be discovered — Teams only hands it out when
   * a person creates the workflow — but the team and channel names are just
   * labels for finding this row again later, and typing them by hand produced
   * rows whose names did not match any real channel.
   */
  const pickWebhookTeam = async (teamName: string) => {
    setWebhook((draft) => ({ ...draft, teamName }));
    const team = teamOptions.find((entry) => entry.displayName === teamName);
    if (!team) {
      setWebhookChannelOptions([]);
      return;
    }
    try {
      const { channels } = await adminApi.microsoftChannels(team.id);
      setWebhookChannelOptions(channels);
    } catch {
      setWebhookChannelOptions([]);
    }
  };

  const handleSaveStorageTarget = async () => {
    setBusy('storage-target');
    setFeedback(null);
    try {
      const result = await adminApi.saveStorageTarget(storageTarget);
      setStorageTargets(result.targets);
      setActiveTargetId(result.activeTargetId);
      setStorageTarget(EMPTY_TARGET);
      setEditingTargetId(null);
      say('storage', 'ok', 
        `Teams ${result.target.teamName} / ${result.target.channelName} 저장 대상을 목록에 저장했습니다.`
      );
    } catch (err: any) {
      say('storage', 'error', err?.message || '저장 대상 변경에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const beginEditTarget = (target: SharePointStorageTarget) => {
    setEditingTargetId(target.id);
    setStorageTarget({ ...target });
    setFeedback(null);
  };

  const cancelEditTarget = () => {
    setEditingTargetId(null);
    setStorageTarget(EMPTY_TARGET);
  };

  /**
   * Finds the channel by name and saves the resolved Graph identifiers.
   *
   * The account is only sent when nothing is remembered — with a signed-in
   * account the server reads the teams from that identity, so a different
   * address typed here would silently mean nothing.
   */
  const handleConnectStorageTarget = async () => {
    setBusy('storage-connect');
    setFeedback(null);
    setTestUpload(null);
    try {
      const result = await adminApi.connectStorageTarget({
        ...(microsoft?.account ? {} : { accountEmail: connectionDraft.accountEmail }),
        teamName: connectionDraft.teamName,
        channelName: connectionDraft.channelName,
      });
      setStorageTargets(result.targets);
      setActiveTargetId(result.activeTargetId);
      setConnectionDraft({ accountEmail: '', teamName: '', channelName: '' });
      setChannelOptions([]);
      say('storage', 'ok', 
        `Teams ${result.target.teamName} / ${result.target.channelName}을(를) 찾아 현재 저장 대상으로 연결했습니다.`
      );
    } catch (err: any) {
      say('storage', 'error', err?.message || 'Teams 저장 대상을 자동으로 찾지 못했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const handleTestStorageUpload = async () => {
    setBusy('storage-test');
    setFeedback(null);
    setTestUpload(null);
    try {
      const result = await adminApi.testStorageTargetUpload();
      setTestUpload({ remotePath: result.remotePath, webUrl: result.webUrl });
      say('storage', 'ok', '임의 PNG 이미지를 실제 SharePoint 저장 대상에 업로드했습니다.');
    } catch (err: any) {
      say('storage', 'error', err?.message || '테스트 이미지 업로드에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const handleSelectStorageTarget = async (id: string) => {
    setBusy(`target-select-${id}`);
    try {
      const result = await adminApi.selectStorageTarget(id);
      setStorageTargets(result.targets);
      setActiveTargetId(result.activeTargetId);
      say('storage', 'ok', 
        `활성 저장 대상을 ${result.target.teamName} / ${result.target.channelName}(으)로 전환했습니다.`
      );
    } catch (err: any) { say('storage', 'error', err?.message || '저장 대상 전환에 실패했습니다.'); }
    finally { setBusy(null); }
  };

  const handleRemoveStorageTarget = async (id: string) => {
    if (!window.confirm('이 저장 대상을 목록에서 삭제할까요?')) return;
    setBusy(`target-remove-${id}`);
    try {
      const result = await adminApi.removeStorageTarget(id);
      setStorageTargets(result.targets);
      setActiveTargetId(result.activeTargetId);
      if (editingTargetId === id) cancelEditTarget();
    } catch (err: any) { say('storage', 'error', err?.message || '저장 대상 삭제에 실패했습니다.'); }
    finally { setBusy(null); }
  };

  const selectTypeConfig = (name: string) => {
    setSelectedType(name);
    const found = typeConfigs.find((entry) => entry.constructionType === name);
    setTypeDraft(found ? structuredClone(found) : null);
  };

  const addDynamicField = () => {
    if (!typeDraft) return;
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setTypeDraft({
      ...typeDraft,
      // The token starts empty and is filled from the item name as it is typed
      // — see updateDynamicField. A random name here is what used to make the
      // folder template unreadable.
      fields: [...typeDraft.fields, {
        id: `field-${suffix}`, label: '', token: '',
        inputType: 'text', required: false, options: [],
      }],
    });
  };

  /**
   * Updates one field, keeping the folder token in step with the item name.
   *
   * The token follows the label only while it *is* the label — the moment the
   * admin types a token of their own, renaming the item stops overwriting it.
   * Without that check, correcting a typo in "주문번호" would silently rewrite a
   * token the folder rule below already refers to.
   */
  const updateDynamicField = (id: string, patch: Partial<ConstructionTypeConfig['fields'][number]>) => {
    if (!typeDraft) return;
    setTypeDraft({
      ...typeDraft,
      fields: typeDraft.fields.map((field) => {
        if (field.id !== id) return field;
        const next = { ...field, ...patch };
        if (patch.label !== undefined && patch.token === undefined) {
          const wasDerived = !field.token || field.token === tokenFromLabel(field.label);
          if (wasDerived) next.token = tokenFromLabel(patch.label);
        }
        return next;
      }),
    });
  };

  const handleSaveTypeConfig = async () => {
    if (!typeDraft) return;
    setBusy('type-config');
    setFeedback(null);
    try {
      const { config } = await adminApi.setConstructionTypeConfig(selectedType, typeDraft);
      setTypeConfigs((items) => items.map((item) => item.constructionType === selectedType ? config : item));
      setTypeDraft(structuredClone(config));
      say('types', 'ok', `${selectedType} 입력 항목과 폴더 규칙을 저장했습니다.`);
    } catch (err: any) {
      say('types', 'error', err?.message || '시공종류별 설정 저장에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  /* ---------------------------------------------------------------- */
  /* Teams 알림                                                         */
  /* ---------------------------------------------------------------- */

  const handleSaveWebhook = async () => {
    setBusy('webhook');
    setFeedback(null);
    try {
      const result = await adminApi.saveTeamsWebhook(webhook);
      setWebhooks(result.webhooks);
      setWebhook(EMPTY_WEBHOOK);
      say('webhook', 'ok', 'Teams 알림 대상을 목록에 저장했습니다. 모든 저장된 대상에 알림이 전송됩니다.');
    } catch (err: any) {
      say('webhook', 'error', err?.message || '알림 주소 저장에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const handleTestWebhook = async () => {
    setBusy('webhook-test');
    setFeedback(null);
    try {
      await adminApi.testTeamsWebhook(webhook.url);
      say('webhook', 'ok', '테스트 카드를 보냈습니다. Teams 채널을 확인해 주세요.');
    } catch (err: any) {
      say('webhook', 'error', err?.message || '테스트 전송에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const handleRemoveWebhook = async (id: string) => {
    if (!window.confirm('이 Teams 알림 대상을 삭제할까요?')) return;
    setBusy(`hook-remove-${id}`);
    try {
      const result = await adminApi.removeTeamsWebhook(id);
      setWebhooks(result.webhooks);
    } catch (err: any) { say('webhook', 'error', err?.message || 'Teams 알림 삭제에 실패했습니다.'); }
    finally { setBusy(null); }
  };

  /* ---------------------------------------------------------------- */
  /* 수신 메일                                                          */
  /* ---------------------------------------------------------------- */

  const runEmail = async (key: string, action: () => Promise<{ deleteRequestEmails: string[] }>,
                          message: string) => {
    setBusy(key);
    setFeedback(null);
    try {
      const { deleteRequestEmails } = await action();
      setEmails(deleteRequestEmails);
      say('email', 'ok', message);
      return true;
    } catch (err: any) {
      say('email', 'error', err?.message || '처리에 실패했습니다.');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const handleAddEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    const email = emailDraft.trim();
    if (!email) return;

    const ok = await runEmail('email-new', () => adminApi.addDeleteRequestEmail(email),
      `${email} 을(를) 수신 목록에 추가했습니다.`);
    if (ok) setEmailDraft('');
  };

  const handleUpdateEmail = async (current: string) => {
    const ok = await runEmail(current, () => adminApi.updateDeleteRequestEmail(current, editEmailDraft),
      '수신 주소를 수정했습니다.');
    if (ok) setEditingEmail(null);
  };

  const handleRemoveEmail = async (email: string) => {
    if (!window.confirm(`${email} 을(를) 수신 목록에서 삭제할까요?`)) return;
    await runEmail(email, () => adminApi.removeDeleteRequestEmail(email),
      `${email} 을(를) 삭제했습니다.`);
  };

  return (
    <div className="max-w-4xl mx-auto py-5 sm:py-8 px-3 sm:px-6">
      <div className="mb-5">
        <h2 className="text-lg sm:text-2xl font-extrabold text-slate-900 flex items-center gap-2">
          <Settings className="w-5 h-5 sm:w-6 sm:h-6 text-blue-600 shrink-0" />
          설정
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          마스터관리자만 변경할 수 있는 운영 설정입니다.
        </p>
      </div>

      <div className="flex items-start gap-2 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600 mb-4">
        <Info className="w-4 h-4 shrink-0 mt-0.5 text-slate-400" />
        <span>
          시공종류는 좌측 <strong>[시공종류 관리]</strong>, 시공기사는{' '}
          <strong>[시공기사 관리]</strong> 화면에서 관리합니다.
        </span>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 mb-4">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <Building2 className="w-4 h-4 text-blue-600" /> Teams · SharePoint 저장 대상
          </h3>
          {helpButton('storage')}
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Microsoft 업무 계정으로 한 번 로그인해 두면, 다음부터는 <strong>팀 이름과 채널 이름만</strong>{' '}
          입력해도 그 채널의 SharePoint 폴더를 찾아 연결합니다. 폴더가 만들어지는 방식은 아래{' '}
          <strong>폴더 규칙</strong>에서 따로 정합니다.
        </p>
        {helpPanel('storage')}
        {message('storage')}

        {/* ---------------------- Microsoft 계정 ---------------------- */}
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 mb-4">
          <div className="flex items-center justify-between gap-3 mb-2">
            <p className="text-xs font-bold text-slate-500">Microsoft 업무 계정</p>
            {helpButton('ms')}
          </div>
          {helpPanel('ms')}
          {message('ms')}
          {microsoft?.account ? (
            <div className="flex flex-wrap items-center gap-3">
              <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0" />
              <div className="flex-1 min-w-[200px]">
                <p className="text-sm font-bold text-slate-900">
                  {microsoft.account.displayName || microsoft.account.upn}
                </p>
                <p className="text-[11px] text-slate-500 truncate">
                  {microsoft.account.upn} · 기억된 계정
                </p>
              </div>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => void handleMicrosoftSignOut()}
                  disabled={busy === 'ms-signout'}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  {busy === 'ms-signout' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogOut className="w-3.5 h-3.5" />}
                  계정 연결 해제
                </button>
              )}
            </div>
          ) : (
            <>
              <p className="text-[11px] text-slate-600 mb-3">
                본인 계정으로 로그인하면 <strong>테넌트 관리자 동의 없이</strong> 본인이 속한 팀을 찾을 수
                있습니다. 비밀번호는 Microsoft 로그인 창에만 입력되며 이 앱은 저장하지 않습니다.
              </p>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => void handleMicrosoftSignIn()}
                  disabled={busy === 'ms-signin' || !microsoft?.configured}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold disabled:opacity-50"
                >
                  {busy === 'ms-signin' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogIn className="w-3.5 h-3.5" />}
                  Microsoft 로그인
                </button>
              )}
              {microsoft && !microsoft.configured && (
                <p className="mt-2 text-[11px] text-amber-700">
                  서버에 Azure 앱 설정(SHAREPOINT_TENANT_ID / CLIENT_ID / CLIENT_SECRET)이 없어 로그인을
                  시작할 수 없습니다.
                </p>
              )}
              {microsoft?.configured && (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <p className="text-[11px] font-bold text-amber-900 mb-1.5">
                    로그인 전에 Azure 앱에 이 주소가 등록되어 있어야 합니다
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="flex-1 min-w-[240px] px-2 py-1.5 rounded bg-white border border-amber-300 font-mono text-[11px] text-slate-700 break-all">
                      {microsoft.redirectUri}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyRedirectUri()}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-amber-400 bg-white text-[11px] font-bold text-amber-900"
                    >
                      {copiedRedirect ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {copiedRedirect ? '복사됨' : '복사'}
                    </button>
                    {microsoft.azureAuthBladeUrl && (
                      <a
                        href={microsoft.azureAuthBladeUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-bold"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        Azure 등록 화면 열기
                      </a>
                    )}
                  </div>
                  <p className="mt-2 text-[11px] text-amber-800">
                    Azure 포털 &gt; 앱 등록 &gt; <strong>인증</strong> &gt; [플랫폼 추가] &gt;{' '}
                    <strong>웹(Web)</strong> 에 위 주소를 그대로 붙여넣고 저장하세요.
                    등록된 주소가 하나도 없으면 로그인 시 <code>AADSTS500113</code> 오류가 납니다.
                  </p>
                  {microsoft.adminConsentUrl && (
                    <p className="mt-2 text-[11px] text-amber-800">
                      개별 사용자 동의가 차단된 테넌트라면 조직 관리자가{' '}
                      <a href={microsoft.adminConsentUrl} target="_blank" rel="noreferrer" className="font-bold underline">
                        이 주소
                      </a>
                      에서 1회 동의하면 모든 사용자에게 적용됩니다.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* ---------------------- 이름으로 연결 ---------------------- */}
        {!readOnly && (
          <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-4 mb-5">
            <p className="text-sm font-bold text-slate-900 mb-1">채널 선택해서 연결</p>
            <p className="text-[11px] text-slate-600 mb-3">
              {microsoft?.account
                ? '기억된 계정이 속한 팀·채널만 보입니다. 목록에 없으면 이름을 직접 입력해도 됩니다.'
                : 'Microsoft 로그인을 하지 않은 경우, 해당 팀에 소속된 계정의 이메일(UPN)이 필요합니다.'}
            </p>
            <div className="grid sm:grid-cols-2 gap-3">
              {!microsoft?.account && (
                <label>
                  <span className="block text-xs font-bold text-slate-700 mb-1.5">Microsoft 업무 계정</span>
                  <input
                    type="email"
                    value={connectionDraft.accountEmail}
                    onChange={(event) => setConnectionDraft({ ...connectionDraft, accountEmail: event.target.value })}
                    placeholder="예: admin@urotech.co.kr"
                    autoComplete="email"
                    className="w-full px-3 py-2.5 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </label>
              )}
              <label>
                <span className="block text-xs font-bold text-slate-700 mb-1.5">Teams 팀 이름</span>
                <input
                  list="ms-team-options"
                  value={connectionDraft.teamName}
                  onChange={(event) => void handlePickTeam(event.target.value)}
                  placeholder="예: 시공서비스"
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <datalist id="ms-team-options">
                  {teamOptions.map((team) => <option key={team.id} value={team.displayName} />)}
                </datalist>
              </label>
              <label>
                <span className="block text-xs font-bold text-slate-700 mb-1.5">채널 이름</span>
                <input
                  list="ms-channel-options"
                  value={connectionDraft.channelName}
                  onChange={(event) => setConnectionDraft({ ...connectionDraft, channelName: event.target.value })}
                  placeholder="예: 시공사진"
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <datalist id="ms-channel-options">
                  {channelOptions.map((channel) => <option key={channel.id} value={channel.displayName} />)}
                </datalist>
              </label>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleConnectStorageTarget()}
                disabled={
                  busy === 'storage-connect' ||
                  (!microsoft?.account && !connectionDraft.accountEmail.trim()) ||
                  !connectionDraft.teamName.trim() ||
                  !connectionDraft.channelName.trim()
                }
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold disabled:opacity-50"
              >
                {busy === 'storage-connect' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Building2 className="w-3.5 h-3.5" />}
                찾아서 연결 · 현재 사용
              </button>
              {microsoft?.account && (
                <button
                  type="button"
                  onClick={() => void loadTeamOptions()}
                  className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-600"
                  title="팀 목록 다시 읽기"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  목록 새로고침
                </button>
              )}
            </div>
          </div>
        )}

        {/* ---------------------- 저장된 연결 목록 ---------------------- */}
        <div className="space-y-2 mb-5">
          {storageTargets.map((target) => (
            <div
              key={target.id}
              className={`rounded-xl border ${target.id === activeTargetId ? 'border-blue-400 bg-blue-50' : 'border-slate-200'}`}
            >
              <div className="flex flex-wrap items-center gap-2 p-3">
                <div className="flex-1 min-w-[220px]">
                  {teamChannelLabel(target.teamName, target.channelName)}
                  <p className="mt-1 text-[11px] text-slate-400 truncate" title={target.siteId || target.driveId}>
                    {target.accountEmail ? `${target.accountEmail} · ` : ''}
                    {target.driveId || target.siteId || 'SharePoint 위치 미설정'}
                  </p>
                </div>
                {target.id === activeTargetId ? (
                  <>
                    <span className="px-2 py-1 rounded-md bg-blue-600 text-white text-[11px] font-bold">현재 사용</span>
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={() => void handleTestStorageUpload()}
                        disabled={busy === 'storage-test'}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-emerald-300 bg-white text-emerald-700 text-xs font-bold disabled:opacity-50"
                      >
                        {busy === 'storage-test' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                        테스트 이미지 업로드
                      </button>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleSelectStorageTarget(target.id)}
                    className="px-2.5 py-1.5 rounded-lg border border-blue-300 bg-white text-blue-700 text-xs font-bold"
                  >
                    선택 전환
                  </button>
                )}
                {!readOnly && (
                  <>
                    <button
                      type="button"
                      onClick={() => (editingTargetId === target.id ? cancelEditTarget() : beginEditTarget(target))}
                      className={`p-2 rounded-lg ${editingTargetId === target.id ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100'}`}
                      title="수정"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRemoveStorageTarget(target.id)}
                      className="p-2 text-slate-500 hover:bg-red-50 hover:text-red-600 rounded-lg"
                      title="삭제"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </>
                )}
              </div>

              {/* The editor opens inside the row it belongs to, so pressing 수정
                  visibly does something. It used to fill a form hidden inside a
                  collapsed 고급 설정 block further down the page. */}
              {editingTargetId === target.id && !readOnly && (
                <div className="border-t border-slate-200 bg-white/70 p-3 rounded-b-xl">
                  <div className="grid sm:grid-cols-2 gap-3">
                    {([
                      ['teamName', 'Teams 팀 이름', '예: 시공서비스'],
                      ['channelName', '채널 이름', '예: 시공사진'],
                      ['accountEmail', 'Microsoft 업무 계정', '예: admin@urotech.co.kr'],
                      ['siteId', 'SharePoint 사이트 ID', 'hostname,site-guid,web-guid'],
                      ['driveId', '문서 라이브러리 드라이브 ID', 'Graph drive ID'],
                    ] as const).map(([key, label, placeholder]) => (
                      <label key={key} className={key === 'driveId' ? 'sm:col-span-2' : ''}>
                        <span className="block text-xs font-bold text-slate-700 mb-1.5">{label}</span>
                        <input
                          type={key === 'accountEmail' ? 'email' : 'text'}
                          value={storageTarget[key]}
                          onChange={(event) => setStorageTarget({ ...storageTarget, [key]: event.target.value })}
                          placeholder={placeholder}
                          className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </label>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500">
                    이 채널의 실제 SharePoint 폴더는 연결할 때 Microsoft에서 읽어 온 값을 그대로
                    유지합니다. 위치를 바꾸려면 위에서 팀·채널을 다시 연결해 주세요.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleSaveStorageTarget()}
                      disabled={busy === 'storage-target' || !storageTarget.teamName || !storageTarget.channelName}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold disabled:opacity-50"
                    >
                      {busy === 'storage-target' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                      수정 저장
                    </button>
                    <button
                      type="button"
                      onClick={cancelEditTarget}
                      className="px-3 py-2.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-600"
                    >
                      취소
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {storageTargets.length === 0 && (
            <p className="p-3 rounded-lg bg-slate-50 text-xs text-slate-500">저장된 연결이 없습니다.</p>
          )}
        </div>

        {testUpload && (
          <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
            <p className="font-bold">실제 업로드 성공</p>
            <p className="mt-1 break-all">{testUpload.remotePath}</p>
            {testUpload.webUrl && (
              <a href={testUpload.webUrl} target="_blank" rel="noreferrer" className="inline-block mt-2 font-bold underline">
                SharePoint에서 테스트 이미지 열기
              </a>
            )}
          </div>
        )}
      </div>

      {/* ======================= 입력 항목 차례 ======================= */}
      <SubmissionOrderSettings
        constructionTypes={typeConfigs.map((entry) => entry.constructionType)}
      />

      {/*
       * ===================== 폴더 생성 규칙 (한 묶음) =====================
       *
       * 시공종류별 규칙과 공통 기본 규칙은 한 가지를 두 단계로 정하는 것입니다.
       * 떨어뜨려 놓으면 "이 업체 폴더가 왜 이렇게 만들어졌지"를 알아보려고
       * 화면을 위아래로 오가야 하고, 둘 중 어느 쪽이 이기는지도 헷갈립니다.
       */}
      <div className="rounded-2xl border-2 border-blue-200 bg-blue-50/40 p-3 sm:p-4 mb-4">
        <div className="flex items-center gap-2 mb-1 px-1">
          <FolderTree className="w-4 h-4 text-blue-600" />
          <h2 className="text-base font-extrabold text-slate-900">폴더 생성 규칙</h2>
        </div>
        <p className="px-1 mb-3 text-xs text-slate-600">
          두 단계로 정합니다 — 시공종류에 <strong>전용 규칙</strong>이 있으면 그것이 이기고,
          없으면 아래 <strong>공통 기본 규칙</strong>을 따릅니다.
        </p>

      <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 mb-4">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h3 className="text-base font-bold text-slate-900">
            <span className="mr-1.5 px-1.5 py-0.5 rounded bg-blue-600 text-[10px] font-bold text-white align-middle">
              1단계
            </span>
            시공종류별 폴더 규칙
          </h3>
          {helpButton('types')}
        </div>
        <p className="text-xs text-slate-500 mb-4">
          시공종류마다 자료가 저장될 폴더 구조를 정합니다. 바꾸지 않은 종류는 아래
          <strong>공통 기본 폴더 규칙</strong>을 따릅니다.
        </p>
        {helpPanel('types')}
        {message('types')}

        {/* 전용 규칙과 기본 규칙을 나눠서 한눈에 보여줍니다. 어떤 종류가 따로
            설정돼 있는지는 펼쳐 보기 전에는 알 수 없었고, 그래서 이미 전용
            규칙이 있는 종류를 다시 손대는 일이 생겼습니다. */}
        {(['custom', 'default'] as const).map((group) => {
          const entries = typeConfigs.filter(
            (entry) => (usesDefaultRule(entry) ? 'default' : 'custom') === group
          );
          if (entries.length === 0) return null;

          return (
            <div key={group} className="mb-4">
              <p className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 mb-2">
                {group === 'custom' ? (
                  <><Sparkles className="w-3.5 h-3.5 text-amber-500" />전용 규칙 ({entries.length})</>
                ) : (
                  <><FolderTree className="w-3.5 h-3.5 text-slate-400" />공통 기본 규칙 사용 ({entries.length})</>
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                {entries.map((entry) => {
                  const selected = entry.constructionType === selectedType;
                  return (
                    <button
                      key={entry.constructionType}
                      type="button"
                      onClick={() => selectTypeConfig(entry.constructionType)}
                      className={`px-3 py-2 rounded-xl border text-xs font-bold transition-colors ${
                        selected
                          ? 'border-blue-500 bg-blue-600 text-white'
                          : group === 'custom'
                            ? 'border-amber-300 bg-amber-50 text-amber-900 hover:border-amber-400'
                            : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'
                      }`}
                    >
                      {entry.constructionType}
                      <span className={`ml-1.5 font-semibold ${selected ? 'text-blue-100' : 'text-slate-400'}`}>
                        {entry.fields.length > 0 ? `입력 ${entry.fields.length}` : '입력 없음'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        {typeDraft && (
          <div className="space-y-4 border-t border-slate-100 pt-4">
            <p className="text-sm font-bold text-slate-900">
              {typeDraft.constructionType}
              <span className="ml-2 text-[11px] font-semibold text-slate-500">
                {usesDefaultRule(typeDraft) ? '공통 기본 규칙 사용 중' : '전용 폴더 규칙 사용 중'}
              </span>
            </p>

            {/* 입력 항목은 [시공종류별 현장] 화면으로 옮겼습니다.
                여기서는 폴더 규칙만 다룹니다 — 둘은 고치는 사람도 주기도
                다릅니다. 입력 항목은 업체 요구가 바뀔 때마다, 폴더 규칙은
                한 번 정하면 거의 건드리지 않습니다. */}
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
              입력 항목(주문자·현장종류 등)은 왼쪽 <strong>[시공종류별 현장]</strong> 화면에서
              관리합니다. 여기서 만든 토큰을 아래 폴더 단계에 쓸 수 있습니다.
            </p>

            {/* 공통 규칙과 같은 짜임입니다 — 단계마다 한 칸, 칸을 고르면 그
                단계에 토큰이 들어가고, 위에 단계별 미리보기가 보입니다.
                한쪽만 텍스트 상자였을 때는, 같은 일을 하는 두 화면을 서로
                다른 방식으로 익혀야 했습니다. */}
            <div className="rounded-xl bg-slate-900 text-slate-100 p-3 overflow-x-auto">
              <p className="text-[11px] text-slate-400 mb-1.5">저장 경로 미리보기 — 단계별</p>
              <div className="flex flex-wrap items-center gap-1 font-mono text-xs sm:text-sm">
                <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-200">
                  {typeDraft.folderRule.root || '(시작 폴더 없음)'}
                </span>
                {typeDraft.folderRule.segments.map((segment, index) => (
                  <React.Fragment key={index}>
                    <span className="text-slate-500">›</span>
                    <span className="px-1.5 py-0.5 rounded bg-blue-600/80 text-white">
                      {fillTokens(segment) || '(빈 단계)'}
                    </span>
                  </React.Fragment>
                ))}
              </div>
            </div>

            <label className="block">
              <span className="block text-xs font-bold text-slate-700 mb-1.5">
                시작 폴더
                <span className="ml-1.5 font-normal text-slate-400">(비워 두면 공통 시작점을 씁니다)</span>
              </span>
              <input
                value={typeDraft.folderRule.root}
                disabled={readOnly}
                onChange={(event) =>
                  setTypeDraft({
                    ...typeDraft,
                    folderRule: { ...typeDraft.folderRule, root: event.target.value },
                  })
                }
                className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-base sm:text-sm disabled:bg-slate-50"
              />
            </label>

            <div>
              <span className="block text-xs font-bold text-slate-700 mb-1.5">
                하위 폴더 단계
                <span className="ml-1.5 font-normal text-slate-400">(위에서부터 순서대로)</span>
              </span>
              <div className="space-y-2">
                {typeDraft.folderRule.segments.map((segment, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <span
                      className={`w-6 h-6 shrink-0 grid place-items-center rounded-full text-[11px] font-bold ${
                        typeSegment === index ? 'bg-blue-600 text-white' : 'text-slate-400'
                      }`}
                    >
                      {index + 1}
                    </span>
                    <input
                      value={segment}
                      disabled={readOnly}
                      onFocus={() => setTypeSegment(index)}
                      onClick={() => setTypeSegment(index)}
                      onChange={(event) => updateTypeSegment(index, event.target.value)}
                      className={`flex-1 min-w-0 px-3 py-2 rounded-lg border font-mono text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50 ${
                        typeSegment === index ? 'border-blue-500 bg-blue-50/40' : 'border-slate-300'
                      }`}
                    />
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={() =>
                          setTypeDraft({
                            ...typeDraft,
                            folderRule: {
                              ...typeDraft.folderRule,
                              segments: typeDraft.folderRule.segments.filter(
                                (_, position) => position !== index
                              ),
                            },
                          })
                        }
                        aria-label={`${index + 1}단계 삭제`}
                        className="p-2 rounded-lg border border-slate-300 text-slate-400 hover:text-rose-600"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {!readOnly && (
                <button
                  type="button"
                  onClick={() =>
                    setTypeDraft({
                      ...typeDraft,
                      folderRule: {
                        ...typeDraft.folderRule,
                        segments: [...typeDraft.folderRule.segments, ''],
                      },
                    })
                  }
                  className="mt-2 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-600"
                >
                  <Plus className="w-3.5 h-3.5" />
                  단계 추가
                </button>
              )}
            </div>

            {!readOnly && (
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
                <p className="text-[11px] font-bold text-slate-600 mb-2">
                  쓸 수 있는 항목 — 누르면
                  <span className="mx-1 px-1.5 py-0.5 rounded bg-blue-600 text-white">
                    {Math.min(typeSegment, Math.max(typeDraft.folderRule.segments.length - 1, 0)) + 1}단계
                  </span>
                  에 추가됩니다
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {tokens.map((info) => (
                    <button
                      key={info.token}
                      type="button"
                      onClick={() =>
                        insertTypeToken(
                          Math.min(typeSegment, typeDraft.folderRule.segments.length - 1),
                          info.token
                        )
                      }
                      title={info.label}
                      className="inline-flex items-baseline gap-1 px-2 py-1 rounded-md bg-white border border-slate-300 hover:border-blue-400 hover:bg-blue-50 text-[11px]"
                    >
                      <span className="font-mono font-semibold text-slate-700">{info.token}</span>
                      <span className="text-slate-400">{info.sample}</span>
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-slate-500">
                  시공종류별 입력 항목에서 만든 토큰({'{현장종류}'} 등)도 그대로 쓸 수 있습니다.
                </p>
              </div>
            )}

            <div className="rounded-xl border border-slate-200 p-3">
              <label className="block text-sm font-bold mb-2">{typeDraft.constructionType} 전용 파일 이름</label>
              <input aria-label="시공종류별 파일 이름 규칙" disabled={readOnly}
                value={typeDraft.folderRule.fileNameTemplate ?? ''}
                onChange={(event) => setTypeDraft({ ...typeDraft, folderRule: { ...typeDraft.folderRule, fileNameTemplate: event.target.value } })}
                placeholder="비우면 공통 파일 이름 사용"
                className="w-full border rounded-lg p-2 font-mono text-sm" />
              <p className="mt-2 text-xs text-slate-500">{'{번호}'}를 반드시 포함하세요. 아래 규칙 저장 버튼으로 저장합니다. 비우면 공통 규칙을 따릅니다.</p>
              <p className="mt-1 text-xs break-all">미리보기: {fillTokens(typeDraft.folderRule.fileNameTemplate || fileNameTemplate || '{폴더명}_{종류}{번호}')}.jpg</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!readOnly && !usesDefaultRule(typeDraft) && (
                <button
                  type="button"
                  onClick={() => setTypeDraft({ ...typeDraft, folderRule: { root, segments: [...segments], fileNameTemplate: '' } })}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-600"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  공통 기본 규칙으로 되돌리기
                </button>
              )}
            </div>
            {!readOnly && <button type="button" onClick={() => void handleSaveTypeConfig()} disabled={busy === 'type-config'}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-xs font-bold disabled:opacity-50">
              {busy === 'type-config' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} 폴더·파일 이름 규칙 저장
            </button>}
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 mb-4">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <span className="mr-1 px-1.5 py-0.5 rounded bg-slate-600 text-[10px] font-bold text-white align-middle">
              2단계
            </span>
            공통 기본 폴더 규칙
          </h3>
          {helpButton('rule')}
        </div>
        <p className="text-xs text-slate-500 mb-4">
          종류별 규칙을 아직 따로 바꾸지 않은 시공종류에 적용되는 기본값입니다.
        </p>
        {helpPanel('rule')}
        {message('rule')}

        {/* 미리보기 */}
        <div className="rounded-xl bg-slate-900 text-slate-100 p-3 mb-4 overflow-x-auto">
          <p className="text-[11px] text-slate-400 mb-1.5">저장 경로 미리보기 — 단계별</p>

          {/* 한 줄로 이어 붙인 경로만 보여 주면 어느 토막이 어느 단계인지
              눈으로 갈라내야 합니다. 단계마다 끊어 보여 주면 규칙을 고칠 때
              몇 번째 칸을 고쳐야 하는지 바로 보입니다. */}
          <div className="flex flex-wrap items-center gap-1 font-mono text-xs sm:text-sm">
            <span className="px-1.5 py-0.5 rounded bg-slate-700 text-slate-200">{root || '…'}</span>
            {segments.map((segment, index) => (
              <React.Fragment key={index}>
                <span className="text-slate-500">›</span>
                <span className="px-1.5 py-0.5 rounded bg-blue-600/80 text-white">
                  {fillTokens(segment) || '(빈 단계)'}
                </span>
              </React.Fragment>
            ))}
          </div>

          <p className="mt-2 font-mono text-[11px] text-slate-400 break-all">
            {example || '불러오는 중...'}
          </p>
        </div>

        {/* 최상위 폴더 */}
        <label className="block mb-4">
          <span className="block text-xs font-bold text-slate-700 mb-1.5">
            최상위 폴더
            <span className="ml-1.5 font-normal text-slate-400">
              (위에서 지정한 채널 폴더 아래의 공통 시작점)
            </span>
          </span>
          <input
            type="text"
            value={root}
            onChange={(event) => setRoot(event.target.value)}
            disabled={readOnly}
            placeholder="예: 시공현장자료"
            className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50"
          />
        </label>

        {/* 폴더 단계 */}
        <span className="block text-xs font-bold text-slate-700 mb-1.5">
          하위 폴더 단계
          <span className="ml-1.5 font-normal text-slate-400">(위에서부터 순서대로)</span>
        </span>
        <div className="space-y-2 mb-3">
          {segments.map((segment, index) => (
            <div key={index} className="flex items-center gap-2">
              <span
                className={`w-6 h-6 shrink-0 grid place-items-center rounded-full text-[11px] font-bold ${
                  activeSegment === index ? 'bg-blue-600 text-white' : 'text-slate-400'
                }`}
              >
                {index + 1}
              </span>
              <input
                type="text"
                value={segment}
                onChange={(event) => updateSegment(index, event.target.value)}
                onFocus={() => setActiveSegment(index)}
                onClick={() => setActiveSegment(index)}
                disabled={readOnly}
                className={`flex-1 min-w-0 px-3 py-2 rounded-lg border font-mono text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50 ${
                  activeSegment === index ? 'border-blue-500 bg-blue-50/40' : 'border-slate-300'
                }`}
              />
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => removeSegment(index)}
                  disabled={segments.length <= 1}
                  className="p-2 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 shrink-0"
                  title={segments.length <= 1 ? '최소 1단계는 필요합니다' : '이 단계 삭제'}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>

        {!readOnly && (
          <>
            <button
              type="button"
              onClick={() => setSegments([...segments, ''])}
              className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-900 mb-4"
            >
              <Plus className="w-3.5 h-3.5" />
              단계 추가
            </button>

            {/* 항목 사전 — 지금 고른 단계에 붙여 넣습니다. */}
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 mb-4">
              <p className="text-[11px] font-bold text-slate-600 mb-2">
                쓸 수 있는 항목 — 누르면
                <span className="mx-1 px-1.5 py-0.5 rounded bg-blue-600 text-white">
                  {Math.min(activeSegment, Math.max(segments.length - 1, 0)) + 1}단계
                </span>
                에 추가됩니다
                <span className="ml-1 font-normal text-slate-400">
                  (위 칸을 누르면 그 단계로 바뀝니다)
                </span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {tokens.map((info) => (
                  <button
                    key={info.token}
                    type="button"
                    onClick={() => insertToken(Math.min(activeSegment, segments.length - 1), info.token)}
                    title={info.label}
                    className="inline-flex items-baseline gap-1 px-2 py-1 rounded-md bg-white border border-slate-300 hover:border-blue-400 hover:bg-blue-50 text-[11px]"
                  >
                    {/* 예시를 함께 적습니다. 이름만으로는 {지역}이 "경기"인지
                        "경기 광명시"인지 알 수 없어, 저장하고 폴더가 만들어진
                        뒤에야 확인하게 됩니다. 넣히는 것은 토큰뿐입니다. */}
                    <span className="font-mono font-semibold text-slate-700">{info.token}</span>
                    <span className="text-slate-400">{info.sample}</span>
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mt-2">
                항목 위에 마우스를 올리면 무슨 값이 들어가는지 보입니다. 빈 값이 나오면 앞뒤
                구분기호(_)는 자동으로 정리됩니다.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleSaveRule()}
                disabled={busy === 'rule' || !isDirty}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-bold"
              >
                {busy === 'rule' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
                저장
              </button>

              {/* 지금 설정을 기본값으로 보관해 둡니다. 되돌릴 곳이 코드에 박힌
                  초기값뿐이면, 규칙을 시험해 보다가 원래 쓰던 값을 잃습니다. */}
              <button
                type="button"
                onClick={() => void handleSaveAsDefault()}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg border border-blue-300 bg-blue-50 disabled:opacity-50 text-xs font-bold text-blue-700"
              >
                {busy === 'rule-default' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Star className="w-3.5 h-3.5" />
                )}
                기본값으로 저장
              </button>

              {savedDefault && (
                <button
                  type="button"
                  onClick={() => {
                    setRoot(savedDefault.root);
                    setSegments([...savedDefault.segments]);
                    setFileNameTemplate(savedDefault.fileNameTemplate ?? '');
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg border border-slate-300 text-xs font-semibold text-slate-600"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  기본값 불러오기
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  setRoot(DEFAULT_RULE.root);
                  setSegments([...DEFAULT_RULE.segments]);
                  setFileNameTemplate('{폴더명}_{종류}{번호}');
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-700"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                기본값
              </button>
              {isDirty && (
                <span className="text-[11px] font-semibold text-amber-700">
                  저장하지 않은 변경이 있습니다
                </span>
              )}
            </div>
          </>
        )}

        {/* ------------------- 저장 파일 이름 규칙 ------------------- */}
        <div className="mt-4 border-t border-slate-100 pt-4">
          <h4 className="text-sm font-bold text-slate-900 mb-1">저장되는 파일 이름</h4>
          {!readOnly && <div className="flex flex-wrap gap-2 my-3">
            <button type="button" disabled={busy !== null} onClick={() => void handleSaveRule()} className="rounded-lg px-4 py-2 bg-blue-600 text-white text-xs font-bold disabled:opacity-50">폴더·파일 이름 저장</button>
            <button type="button" disabled={busy !== null} onClick={() => void handleSaveAsDefault()} className="rounded-lg px-4 py-2 border border-blue-300 text-blue-700 text-xs font-bold disabled:opacity-50">현재 설정을 기본값으로 저장</button>
            {savedDefault && <button type="button" onClick={() => { setRoot(savedDefault.root); setSegments([...savedDefault.segments]); setFileNameTemplate(savedDefault.fileNameTemplate ?? ''); }} className="rounded-lg px-4 py-2 border text-xs">기본값 불러오기</button>}
            {isDirty && <span className="text-xs text-amber-700 self-center">저장하지 않은 변경이 있습니다</span>}
          </div>}
          <p className="text-xs text-slate-500 mb-2">
            공통 기본 파일 이름입니다. 위 시공종류별 설정에서 전용 파일 이름을 저장하면 해당 종류에는 전용 규칙이 적용됩니다.
          </p>

          <input
            disabled={readOnly}
            value={fileNameTemplate}
            onChange={(event) => setFileNameTemplate(event.target.value)}
            placeholder="{폴더명}_{종류}{번호}"
            className="w-full px-3 py-2 rounded-lg border border-slate-300 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />

          <div className="flex flex-wrap gap-1.5 mt-2">
            {fileNameTokens.map((entry) => (
              <button
                key={entry.token}
                type="button"
                onClick={() => setFileNameTemplate((current) => `${current}${entry.token}`)}
                title={entry.label}
                className="inline-flex items-baseline gap-1 px-2 py-1 rounded-md border border-slate-300 bg-white text-[11px] hover:border-blue-400"
              >
                <span className="font-mono font-semibold text-slate-700">{entry.token}</span>
                <span className="text-slate-400">{entry.sample}</span>
              </button>
            ))}
          </div>

          <p className="mt-2 text-[11px] text-slate-500">
            미리보기 ·{' '}
            <span className="font-mono font-semibold text-slate-700">
              {fillTokens(fileNameTemplate || '{폴더명}_{종류}{번호}')}.jpg
            </span>
          </p>

          {/* {번호} 는 빼면 안 됩니다. 같은 이름끼리 덮어써서 자료가 사라집니다. */}
          {!(fileNameTemplate || '{번호}').includes('{번호}') && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[11px] font-semibold text-rose-700">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              {'{번호}'} 가 빠지면 한 폴더의 파일이 모두 같은 이름이 되어 덮어써집니다. 저장되지
              않습니다.
            </p>
          )}
        </div>

        <div className="mt-4 flex items-start gap-2 text-[11px] text-slate-500 border-t border-slate-100 pt-3">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-400" />
          <span>
            같은 현장에 두 번째로 자료가 올라오면 가장 아래 폴더에{' '}
            <strong>_중복방지-01</strong> 을 붙여 새 폴더를 만듭니다. 1차 시공과 재방문이 한
            폴더에 섞이지 않습니다.
            <br />
            규칙을 바꿔도 <strong>이미 저장된 폴더는 옮겨지지 않습니다.</strong> 다음 제출부터
            적용되므로, 운영 중에 자주 바꾸면 같은 현장 자료가 여러 위치로 흩어집니다.
          </span>
        </div>
      </div>
      </div>

      {/* ========================== Teams 알림 ========================== */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 mb-4">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <Bell className="w-4 h-4 text-blue-600" />
            Teams 알림
          </h3>
          {helpButton('webhook')}
        </div>
        <p className="text-xs text-slate-500 mb-4">
          자료 제출이 끝나면 Teams 채널에 카드를 보냅니다. <strong>저장이 확인된 뒤에만</strong>{' '}
          보내며 저장된 모든 알림 대상에 전송합니다.
        </p>
        {helpPanel('webhook')}
        {message('webhook')}

        <div className="space-y-2 mb-4">
          {webhooks.map((entry) => (
            <div
              key={entry.id}
              className={`flex items-center gap-2 p-3 rounded-xl border ${
                webhook.id === entry.id ? 'border-blue-400 bg-blue-50' : 'border-slate-200'
              }`}
            >
              <div className="flex-1 min-w-0">
                {teamChannelLabel(entry.teamName, entry.channelName)}
                <p className="mt-1 text-[11px] text-slate-400 truncate" title={entry.url}>{entry.url}</p>
              </div>
              {!readOnly && (
                <>
                  <button
                    type="button"
                    onClick={() => (webhook.id === entry.id ? setWebhook(EMPTY_WEBHOOK) : setWebhook({ ...entry }))}
                    className={`p-2 rounded-lg ${webhook.id === entry.id ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100'}`}
                    title="수정"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRemoveWebhook(entry.id)}
                    className="p-2 text-slate-500 hover:bg-red-50 hover:text-red-600 rounded-lg"
                    title="삭제"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>
          ))}
          {webhooks.length === 0 && (
            <p className="p-3 rounded-lg bg-slate-50 text-xs text-slate-500">저장된 Teams 알림 대상이 없습니다.</p>
          )}
        </div>

        {!readOnly && (
          <div className="rounded-xl border border-slate-200 p-4">
            <p className="text-sm font-bold text-slate-900 mb-3">
              {webhook.id ? '알림 대상 수정' : '알림 대상 추가'}
            </p>

            {/* Stacked, not a row: the three values are of very different
                lengths — two short names and one very long URL — and side by
                side the URL field squeezed the names down to a few characters. */}
            <div className="space-y-3">
              <label className="block">
                <span className="block text-xs font-bold text-slate-700 mb-1.5">Teams 팀 이름</span>
                <input
                  list="ms-team-options"
                  value={webhook.teamName}
                  onChange={(e) => void pickWebhookTeam(e.target.value)}
                  placeholder="예: 시공서비스"
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </label>
              <label className="block">
                <span className="block text-xs font-bold text-slate-700 mb-1.5">채널 이름</span>
                <input
                  list="ms-webhook-channel-options"
                  value={webhook.channelName}
                  onChange={(e) => setWebhook({ ...webhook, channelName: e.target.value })}
                  placeholder="예: 시공사진"
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm font-semibold text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <datalist id="ms-webhook-channel-options">
                  {webhookChannelOptions.map((channel) => (
                    <option key={channel.id} value={channel.displayName} />
                  ))}
                </datalist>
              </label>
              <label className="block">
                <span className="block text-xs font-bold text-slate-700 mb-1.5">
                  Teams 워크플로 주소
                  <span className="ml-1.5 font-normal text-slate-400">(Teams에서 만들어 붙여넣기)</span>
                </span>
                <input
                  type="url"
                  value={webhook.url}
                  onChange={(e) => setWebhook({ ...webhook, url: e.target.value })}
                  className="w-full px-3 py-2.5 rounded-lg border border-slate-300 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="https://...logic.azure.com/... 또는 https://....powerplatform.com/..."
                />
              </label>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleSaveWebhook()}
                disabled={busy === 'webhook' || !webhook.teamName || !webhook.channelName || !webhook.url}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-bold"
              >
                {busy === 'webhook' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                {webhook.id ? '수정 저장' : '목록에 추가'}
              </button>
              <button
                type="button"
                onClick={() => void handleTestWebhook()}
                disabled={busy === 'webhook-test' || !webhook.url.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50 text-xs font-semibold text-slate-700"
              >
                {busy === 'webhook-test' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                테스트 카드 보내기
              </button>
              {webhook.id && (
                <button
                  type="button"
                  onClick={() => setWebhook(EMPTY_WEBHOOK)}
                  className="px-3 py-2.5 rounded-lg border border-slate-300 text-xs font-semibold"
                >
                  수정 취소
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ======================= 삭제 요청 수신 메일 ======================= */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <Mail className="w-4 h-4 text-blue-600" />
            삭제 요청·업로드 오류 수신 메일
          </h3>
          {helpButton('email')}
        </div>
        <p className="text-xs text-slate-500 mb-4">
          업체 관리자가 시공기사 삭제를 시도하면, 여기 등록된{' '}
          <strong>전원에게</strong> 요청 메일을 보낼 수 있습니다. 자료 저장이 최종 실패한 경우에도 이 목록으로 주문번호·주문자·주소·시공일·실패 파일과 오류 내용을 자동 발송합니다.
        </p>
        <p className="text-xs text-amber-700 mb-4">자동 오류 메일에는 Azure 환경변수 MAIL_SENDER(발신 사서함)와 앱의 Microsoft Graph Mail.Send 애플리케이션 권한 및 관리자 동의가 필요합니다. 수신자만 등록하면 메일 발송 설정이 완료되는 것은 아닙니다.</p>
        {!readOnly && <div className="rounded-lg bg-slate-50 p-3 text-xs mb-4 space-y-2">
          <p>현재 기록 저장소: {storageStatus ? storageStatus.backend === 'AZURE_TABLES' ? `Azure Table Storage (${storageStatus.account})` : '서버 로컬 JSON — Azure 연결 상태를 확인하세요.' : '확인되지 않음'}</p>
          <p>메일 기본 설정: {storageStatus ? storageStatus.mailConfigured ? `입력됨 / 발신자 ${storageStatus.sender} (실제 발송 권한은 별도 확인 필요)` : '미완료 — 발신자, 수신자, Graph 인증 설정을 확인하세요.' : '확인되지 않음'}</p>
          <button type="button" className="underline text-blue-700" onClick={() => void adminApi.storageStatus().then(setStorageStatus).catch(() => setStorageStatus(null))}>저장소·메일 설정 상태 새로고침</button>
        </div>}
        {helpPanel('email')}
        {message('email')}

        {!readOnly && (
          <form onSubmit={handleAddEmail} className="flex flex-wrap items-center gap-2 mb-4">
            <input
              type="email"
              value={emailDraft}
              onChange={(event) => setEmailDraft(event.target.value)}
              placeholder="예: admin@urotech.co.kr"
              className="flex-1 min-w-[200px] px-3 py-2.5 rounded-lg border border-slate-300 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={busy === 'email-new' || !emailDraft.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-bold"
            >
              {busy === 'email-new' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}
              추가
            </button>
          </form>
        )}

        {emails.length === 0 ? (
          <div className="flex items-start gap-2 p-4 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
            <Info className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              등록된 주소가 없습니다. 지금은 삭제 요청 시 &quot;마스터관리자에게 문의&quot; 로만
              안내됩니다.
            </span>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
            {emails.map((email) => {
              const isEditing = editingEmail === email;
              const isBusy = busy === email;

              return (
                <li key={email} className="flex items-center gap-2 px-3 py-2.5">
                  <Mail className="w-4 h-4 text-slate-400 shrink-0" />

                  {isEditing ? (
                    <input
                      type="email"
                      value={editEmailDraft}
                      onChange={(event) => setEditEmailDraft(event.target.value)}
                      className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <span className="flex-1 min-w-0 text-sm font-semibold text-slate-800 truncate">
                      {email}
                    </span>
                  )}

                  {!readOnly && (
                    <div className="flex items-center gap-1 shrink-0">
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void handleUpdateEmail(email)}
                            disabled={isBusy}
                            className="p-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60"
                            title="저장"
                          >
                            {isBusy ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Check className="w-4 h-4" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingEmail(null)}
                            className="p-2 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50"
                            title="취소"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingEmail(email);
                              setEditEmailDraft(email);
                            }}
                            className="p-2 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                            title="수정"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleRemoveEmail(email)}
                            disabled={isBusy}
                            className="p-2 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
                            title="삭제"
                          >
                            {isBusy ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Trash2 className="w-4 h-4" />
                            )}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {emails.length > 0 && (
          <p className="mt-3 text-[11px] text-slate-500">
            현재 <strong>{emails.length}명</strong>이 등록되어 있습니다. 삭제 요청 창에도 이
            목록이 그대로 표시되어, 요청자가 누구에게 가는지 알 수 있습니다.
          </p>
        )}
      </div>
    </div>
  );
};
