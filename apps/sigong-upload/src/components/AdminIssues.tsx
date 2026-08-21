import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  Timer,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { adminApi } from '../api';
import type { Issue, IssuePriority, IssueStatus } from '../types';

const STATUS_META: Record<IssueStatus, { label: string; className: string; Icon: typeof CircleDot }> = {
  OPEN: { label: '열림', className: 'bg-blue-100 text-blue-800 border-blue-200', Icon: CircleDot },
  IN_PROGRESS: {
    label: '처리 중',
    className: 'bg-amber-100 text-amber-800 border-amber-200',
    Icon: Timer,
  },
  RESOLVED: {
    label: '해결됨',
    className: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    Icon: CheckCircle2,
  },
};

const PRIORITY_META: Record<IssuePriority, { label: string; className: string }> = {
  HIGH: { label: '높음', className: 'bg-red-100 text-red-800 border-red-200' },
  NORMAL: { label: '보통', className: 'bg-slate-100 text-slate-700 border-slate-200' },
  LOW: { label: '낮음', className: 'bg-slate-100 text-slate-500 border-slate-200' },
};

const STATUS_ORDER: IssueStatus[] = ['OPEN', 'IN_PROGRESS', 'RESOLVED'];

interface AdminIssuesProps {
  /** Pre-fills the site field when an issue is raised from a submission. */
  defaultSiteId?: string;
  onOpenSite: (siteId: string) => void;
  /** False for 일반 권한 accounts: the thread stays readable, but read-only. */
  canEdit: boolean;
}

export const AdminIssues: React.FC<AdminIssuesProps> = ({
  defaultSiteId,
  onOpenSite,
  canEdit,
}) => {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [statusFilter, setStatusFilter] = useState<IssueStatus | ''>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [draft, setDraft] = useState({
    title: '',
    body: '',
    siteId: defaultSiteId || '',
    priority: 'NORMAL' as IssuePriority,
  });
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (status: IssueStatus | '') => {
    setIsLoading(true);
    setError(null);
    try {
      const page = await adminApi.issues({ status: status || undefined, limit: 100 });
      setIssues(page.items);
    } catch (err: any) {
      setError(err?.message || '이슈 목록을 불러오지 못했습니다.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(statusFilter);
  }, [statusFilter, load]);

  /** Replaces one issue in place so the list keeps its scroll position. */
  const replaceIssue = (updated: Issue) =>
    setIssues((prev) => prev.map((issue) => (issue.id === updated.id ? updated : issue)));

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.title.trim()) return;

    setBusyId('new');
    try {
      const { issue } = await adminApi.createIssue({
        title: draft.title,
        body: draft.body,
        siteId: draft.siteId || undefined,
        priority: draft.priority,
      });
      setIssues((prev) => [issue, ...prev]);
      setDraft({ title: '', body: '', siteId: defaultSiteId || '', priority: 'NORMAL' });
      setIsComposing(false);
    } catch (err: any) {
      setError(err?.message || '이슈 등록에 실패했습니다.');
    } finally {
      setBusyId(null);
    }
  };

  const handleStatusChange = async (issue: Issue, status: IssueStatus) => {
    setBusyId(issue.id);
    try {
      const result = await adminApi.updateIssue(issue.id, { status });
      replaceIssue(result.issue);
    } catch (err: any) {
      setError(err?.message || '상태 변경에 실패했습니다.');
    } finally {
      setBusyId(null);
    }
  };

  const handleComment = async (issue: Issue) => {
    const body = (commentDrafts[issue.id] || '').trim();
    if (!body) return;

    setBusyId(issue.id);
    try {
      const result = await adminApi.commentOnIssue(issue.id, body);
      replaceIssue(result.issue);
      setCommentDrafts((prev) => ({ ...prev, [issue.id]: '' }));
    } catch (err: any) {
      setError(err?.message || '댓글 등록에 실패했습니다.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (issue: Issue) => {
    if (!window.confirm(`이슈 "${issue.title}" 를 삭제할까요? 되돌릴 수 없습니다.`)) return;

    setBusyId(issue.id);
    try {
      await adminApi.deleteIssue(issue.id);
      setIssues((prev) => prev.filter((candidate) => candidate.id !== issue.id));
    } catch (err: any) {
      setError(err?.message || '이슈 삭제에 실패했습니다.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="max-w-5xl mx-auto py-6 sm:py-8 px-4 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h2 className="text-xl sm:text-2xl font-extrabold text-slate-900 flex items-center gap-2">
            <AlertTriangle className="w-6 h-6 text-amber-500" />
            이슈 관리
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            업로드 실패, 자료 누락, 재촬영 요청 등 후속 조치가 필요한 사항을 기록합니다.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load(statusFilter)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-blue-600' : ''}`} />
            <span>새로고침</span>
          </button>
          {canEdit && (
            <button
              type="button"
              onClick={() => setIsComposing((prev) => !prev)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold"
            >
              {isComposing ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
              <span>{isComposing ? '취소' : '새 이슈'}</span>
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 mb-4">
          <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} className="shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {isComposing && canEdit && (
        <form
          onSubmit={handleCreate}
          className="bg-white rounded-2xl border border-slate-200 p-5 mb-5 space-y-3.5"
        >
          <input
            type="text"
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            placeholder="이슈 제목 (예: 2026-08-14 광명 현장 동영상 업로드 실패)"
            required
            className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <textarea
            value={draft.body}
            onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            placeholder="상세 내용, 재현 방법, 담당자 연락 결과 등"
            rows={4}
            className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
          />
          <div className="flex flex-wrap gap-3">
            <input
              type="text"
              value={draft.siteId}
              onChange={(event) => setDraft({ ...draft, siteId: event.target.value })}
              placeholder="관련 현장 ID (선택)"
              className="flex-1 min-w-48 px-3 py-2 rounded-lg border border-slate-300 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <select
              value={draft.priority}
              onChange={(event) =>
                setDraft({ ...draft, priority: event.target.value as IssuePriority })
              }
              className="px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="HIGH">우선순위: 높음</option>
              <option value="NORMAL">우선순위: 보통</option>
              <option value="LOW">우선순위: 낮음</option>
            </select>
            <button
              type="submit"
              disabled={busyId === 'new'}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-xs font-bold"
            >
              {busyId === 'new' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>등록</span>
            </button>
          </div>
        </form>
      )}

      {/* Status filter */}
      <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg text-xs font-medium w-fit mb-4">
        {([{ value: '' as const, label: '전체' }] as Array<{ value: IssueStatus | ''; label: string }>)
          .concat(STATUS_ORDER.map((status) => ({ value: status, label: STATUS_META[status].label })))
          .map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => setStatusFilter(option.value)}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                statusFilter === option.value
                  ? 'bg-white text-slate-900 shadow-xs font-bold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {option.label}
            </button>
          ))}
      </div>

      {issues.length === 0 && !isLoading ? (
        <p className="py-16 text-center text-xs text-slate-400 bg-white rounded-2xl border border-slate-200">
          등록된 이슈가 없습니다.
        </p>
      ) : (
        <div className="space-y-3">
          {issues.map((issue) => {
            const meta = STATUS_META[issue.status];
            const priority = PRIORITY_META[issue.priority];
            const isBusy = busyId === issue.id;

            return (
              <div key={issue.id} className="bg-white rounded-2xl border border-slate-200 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 mb-1.5">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border ${meta.className}`}
                      >
                        <meta.Icon className="w-3 h-3" />
                        {meta.label}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[11px] font-bold border ${priority.className}`}
                      >
                        {priority.label}
                      </span>
                      {issue.siteId && (
                        <button
                          type="button"
                          onClick={() => onOpenSite(issue.siteId!)}
                          className="text-[11px] font-mono text-blue-700 hover:underline"
                        >
                          {issue.siteId}
                        </button>
                      )}
                    </div>
                    <h3 className="text-sm font-bold text-slate-900">{issue.title}</h3>
                    {issue.body && (
                      <p className="text-xs text-slate-600 mt-1.5 whitespace-pre-wrap leading-relaxed">
                        {issue.body}
                      </p>
                    )}
                    <p className="text-[11px] text-slate-400 mt-2">
                      {issue.author} · 등록 {new Date(issue.createdAt).toLocaleString('ko-KR')}
                      {issue.updatedAt !== issue.createdAt &&
                        ` · 수정 ${new Date(issue.updatedAt).toLocaleString('ko-KR')}`}
                    </p>
                  </div>

                  {canEdit && (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <select
                        value={issue.status}
                        disabled={isBusy}
                        onChange={(event) =>
                          void handleStatusChange(issue, event.target.value as IssueStatus)
                        }
                        className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-[11px] font-semibold bg-white disabled:opacity-60"
                      >
                        {STATUS_ORDER.map((status) => (
                          <option key={status} value={status}>
                            {STATUS_META[status].label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => void handleDelete(issue)}
                        disabled={isBusy}
                        className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 disabled:opacity-60"
                        title="이슈 삭제"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Comment thread */}
                <div className="mt-4 pt-4 border-t border-slate-100">
                  {issue.comments.length > 0 && (
                    <ul className="space-y-2 mb-3">
                      {issue.comments.map((comment) => (
                        <li key={comment.id} className="bg-slate-50 rounded-lg p-2.5">
                          <div className="flex items-center gap-2 text-[11px] text-slate-500 mb-1">
                            <MessageSquare className="w-3 h-3" />
                            <span className="font-semibold text-slate-700">{comment.author}</span>
                            <span>{new Date(comment.at).toLocaleString('ko-KR')}</span>
                          </div>
                          <p className="text-xs text-slate-700 whitespace-pre-wrap">{comment.body}</p>
                        </li>
                      ))}
                    </ul>
                  )}

                  {canEdit && (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={commentDrafts[issue.id] || ''}
                      onChange={(event) =>
                        setCommentDrafts((prev) => ({ ...prev, [issue.id]: event.target.value }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          void handleComment(issue);
                        }
                      }}
                      placeholder="처리 내용 기록..."
                      className="flex-1 px-3 py-2 rounded-lg border border-slate-300 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                      type="button"
                      onClick={() => void handleComment(issue)}
                      disabled={isBusy || !(commentDrafts[issue.id] || '').trim()}
                      className="p-2 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white"
                      title="기록 추가"
                    >
                      {isBusy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Send className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
