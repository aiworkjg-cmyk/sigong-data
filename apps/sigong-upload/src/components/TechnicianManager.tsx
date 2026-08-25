import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Loader2,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Trash2,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { adminApi } from '../api';
import { titleStyle } from '../technicians';
import { typeStyle } from '../constructionTypes';
import { TECHNICIAN_TITLES, canDeleteTechnicians, isMaster } from '../types';
import type { AdminSession, Technician, TechnicianTitle } from '../types';

interface TechnicianManagerProps {
  session: AdminSession;
}

interface Draft {
  name: string;
  title: TechnicianTitle;
  constructionTypes: string[];
  phone: string;
  region: string;
}

const EMPTY_DRAFT: Draft = {
  name: '',
  title: '부사수',
  constructionTypes: [],
  phone: '',
  region: '',
};

/**
 * 시공기사 명부.
 *
 * 마스터 and 업체 관리자 both add and edit people here, but only the master may
 * delete: a roster entry is referenced by every past submission and possibly by
 * a login, so removal is a decision that needs one owner. Everyone else gets a
 * popup pointing at the address the master configured.
 *
 * 업체 is what decides who can see whom — a 업체 관리자 is served only the
 * entries carrying their own 업체, and can only tag within it.
 */
export const TechnicianManager: React.FC<TechnicianManagerProps> = ({ session }) => {
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [assignableTypes, setAssignableTypes] = useState<string[]>([]);
  const [deleteRequestEmails, setDeleteRequestEmails] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [isComposing, setIsComposing] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [deleteRequest, setDeleteRequest] = useState<Technician | null>(null);

  const mayDelete = canDeleteTechnicians(session.role);
  const master = isMaster(session.role);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await adminApi.technicians();
      setTechnicians(result.technicians);
      setAssignableTypes(result.assignableTypes);
      setDeleteRequestEmails(result.deleteRequestEmails);
    } catch (err: any) {
      setError(err?.message || '시공기사 명부를 불러오지 못했습니다.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim()) return;

    setBusy('new');
    setError(null);
    try {
      const { technicians: list } = await adminApi.addTechnician({
        name: draft.name,
        title: draft.title,
        constructionTypes: draft.constructionTypes,
        phone: draft.phone,
        region: draft.region,
      });
      setTechnicians(list);
      setDraft(EMPTY_DRAFT);
      setIsComposing(false);
      setNotice(`${draft.name} (${draft.title}) 을(를) 명부에 추가했습니다.`);
    } catch (err: any) {
      setError(err?.message || '시공기사 추가에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const handleSaveEdit = async (id: string) => {
    // Removing the last 업체 the editor owns makes the person vanish from their
    // own list — legitimate, but never something to discover after the fact.
    const losesVisibility =
      !master &&
      assignableTypes.length > 0 &&
      !editDraft.constructionTypes.some((type) => assignableTypes.includes(type));

    if (
      losesVisibility &&
      !window.confirm(
        `${editDraft.name} 님에게서 담당 업체를 모두 해제하면 이 목록에서 더 이상 보이지 않게 됩니다. 계속할까요?`
      )
    ) {
      return;
    }

    setBusy(id);
    setError(null);
    try {
      const { technicians: list } = await adminApi.updateTechnician(id, {
        name: editDraft.name,
        title: editDraft.title,
        constructionTypes: editDraft.constructionTypes,
        phone: editDraft.phone,
        region: editDraft.region,
      });
      setTechnicians(list);
      setEditingId(null);
      setNotice('기사 정보를 수정했습니다.');
    } catch (err: any) {
      setError(err?.message || '수정에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (technician: Technician) => {
    // 업체 관리자 cannot delete — show the request popup instead of a 403.
    if (!mayDelete) {
      setDeleteRequest(technician);
      return;
    }
    if (!window.confirm(`${technician.name} (${technician.title}) 을(를) 명부에서 삭제할까요?`)) {
      return;
    }

    setBusy(technician.id);
    setError(null);
    try {
      const { technicians: list } = await adminApi.deleteTechnician(technician.id);
      setTechnicians(list);
      setNotice(`${technician.name} 을(를) 명부에서 삭제했습니다.`);
    } catch (err: any) {
      setError(err?.message || '삭제에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const startEdit = (tech: Technician) => {
    setEditingId(tech.id);
    setEditDraft({
      name: tech.name,
      title: tech.title,
      constructionTypes: tech.constructionTypes,
      phone: tech.phone ?? '',
      region: tech.region ?? '',
    });
  };

  return (
    <div className="max-w-4xl mx-auto py-5 sm:py-8 px-3 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <h2 className="text-lg sm:text-2xl font-extrabold text-slate-900 flex items-center gap-2">
            <Users className="w-5 h-5 sm:w-6 sm:h-6 text-blue-600 shrink-0" />
            시공기사 관리
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            {master
              ? '제출 화면에서 선택할 수 있는 기사 명부입니다.'
              : `담당 업체(${session.constructionTypes.join(', ')})의 기사만 표시됩니다.`}
            {!mayDelete && ' 삭제는 마스터관리자에게 요청해 주세요.'}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-blue-600' : ''}`} />
            <span className="hidden sm:inline">새로고침</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setIsComposing((prev) => !prev);
              // A company manager's additions default to their own 업체.
              setDraft({ ...EMPTY_DRAFT, constructionTypes: master ? [] : assignableTypes });
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold"
          >
            {isComposing ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            <span>{isComposing ? '취소' : '기사 추가'}</span>
          </button>
        </div>
      </div>

      {error && (
        <Banner tone="error" onClose={() => setError(null)}>
          {error}
        </Banner>
      )}
      {notice && (
        <Banner tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Banner>
      )}

      {isComposing && (
        <form
          onSubmit={handleAdd}
          className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 mb-4 space-y-3.5"
        >
          <TechnicianFields
            draft={draft}
            onChange={setDraft}
            assignableTypes={assignableTypes}
            master={master}
          />

          <button
            type="submit"
            disabled={busy === 'new' || !draft.name.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-bold"
          >
            {busy === 'new' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5" />
            )}
            <span>명부에 추가</span>
          </button>
        </form>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
        {technicians.length === 0 && !isLoading ? (
          <p className="py-16 text-center text-xs text-slate-400">
            {master
              ? '등록된 시공기사가 없습니다. [기사 추가]로 명부를 만들어 주세요.'
              : '담당 업체로 등록된 시공기사가 없습니다.'}
          </p>
        ) : (
          technicians.map((tech) => {
            const style = titleStyle(tech.title);
            const isEditing = editingId === tech.id;
            const isBusy = busy === tech.id;

            if (isEditing) {
              return (
                <div key={tech.id} className="px-3 sm:px-4 py-4 space-y-3.5 bg-slate-50/60">
                  <TechnicianFields
                    draft={editDraft}
                    onChange={setEditDraft}
                    assignableTypes={assignableTypes}
                    master={master}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleSaveEdit(tech.id)}
                      disabled={isBusy}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold disabled:opacity-60"
                    >
                      {isBusy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Check className="w-3.5 h-3.5" />
                      )}
                      저장
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="px-3 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-white text-xs font-bold"
                    >
                      취소
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div key={tech.id} className="flex items-start gap-2.5 px-3 sm:px-4 py-3">
                <span className={`w-1.5 h-10 rounded-full shrink-0 mt-0.5 ${style.accent}`} />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-bold text-slate-900 truncate">{tech.name}</span>
                    <span
                      className={`px-2 py-0.5 rounded-full border text-[11px] font-bold ${style.chip}`}
                    >
                      {tech.title}
                    </span>
                    {tech.constructionTypes.length > 0 ? (
                      tech.constructionTypes.map((type) => (
                        <span
                          key={type}
                          className={`px-1.5 py-0.5 rounded border text-[11px] font-bold ${typeStyle(type).chip}`}
                        >
                          {type}
                        </span>
                      ))
                    ) : (
                      <span className="px-1.5 py-0.5 rounded border border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
                        업체 미지정
                      </span>
                    )}
                  </div>

                  {(tech.phone || tech.region) && (
                    <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-600">
                      {tech.phone && (
                        <span className="inline-flex items-center gap-1">
                          <Phone className="w-3 h-3 text-slate-400" />
                          {tech.phone}
                        </span>
                      )}
                      {tech.region && (
                        <span className="inline-flex items-center gap-1 truncate">
                          <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                          {tech.region}
                        </span>
                      )}
                    </div>
                  )}

                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {tech.createdAt && `등록 ${new Date(tech.createdAt).toLocaleDateString('ko-KR')}`}
                    {tech.createdBy && ` · ${tech.createdBy}`}
                    {master && tech.constructionTypes.length === 0 && (
                      <span className="text-amber-700 font-semibold">
                        {' '}
                        · 업체 관리자에게는 보이지 않음
                      </span>
                    )}
                  </p>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => startEdit(tech)}
                    className="p-2 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                    title="정보 수정"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(tech)}
                    disabled={isBusy}
                    className="p-2 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
                    title={mayDelete ? '명부에서 삭제' : '삭제 요청'}
                  >
                    {isBusy ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <p className="mt-4 text-[11px] text-slate-500 leading-relaxed">
        이름이나 직함을 수정해도 <strong>이미 제출된 자료의 기록은 그대로 유지</strong>됩니다. 과거
        자료는 제출 당시의 이름과 직함을 그대로 보관합니다.
        {master && ' 업체를 지정하지 않은 기사는 마스터에게만 보입니다.'}
      </p>

      {deleteRequest && (
        <DeleteRequestDialog
          technician={deleteRequest}
          emails={deleteRequestEmails}
          requesterName={session.displayName}
          onClose={() => setDeleteRequest(null)}
        />
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */

/** Shared by the add form and the inline editor so both stay in step. */
const TechnicianFields: React.FC<{
  draft: Draft;
  onChange: (draft: Draft) => void;
  assignableTypes: string[];
  master: boolean;
}> = ({ draft, onChange, assignableTypes, master }) => (
  <>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label className="block text-xs font-bold text-slate-700 mb-1.5">
          이름 <span className="text-rose-500">*</span>
        </label>
        <input
          type="text"
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder="예: 홍길동"
          maxLength={20}
          required
          className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div>
        <label className="block text-xs font-bold text-slate-700 mb-1.5">
          직함 <span className="text-rose-500">*</span>
        </label>
        <div className="flex gap-1.5">
          {TECHNICIAN_TITLES.map((title) => {
            const style = titleStyle(title);
            const selected = draft.title === title;
            return (
              <button
                key={title}
                type="button"
                onClick={() => onChange({ ...draft, title })}
                className={`flex-1 px-2 py-2.5 rounded-lg border-2 text-xs font-bold transition-colors ${
                  selected ? style.selected : 'border-slate-200 bg-white text-slate-600'
                }`}
              >
                {title}
              </button>
            );
          })}
        </div>
      </div>
    </div>

    <div>
      <label className="block text-xs font-bold text-slate-700 mb-1.5">
        소속 업체
        <span className="ml-1.5 font-normal text-slate-400">
          (선택 · 여러 개 가능{master ? ' · 미지정 시 마스터만 조회' : ''})
        </span>
      </label>
      {assignableTypes.length === 0 ? (
        <p className="text-[11px] text-slate-400">지정할 수 있는 업체가 없습니다.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {assignableTypes.map((type) => {
            const selected = draft.constructionTypes.includes(type);
            const style = typeStyle(type);
            return (
              <button
                key={type}
                type="button"
                onClick={() =>
                  onChange({
                    ...draft,
                    constructionTypes: selected
                      ? draft.constructionTypes.filter((value) => value !== type)
                      : [...draft.constructionTypes, type],
                  })
                }
                className={`px-2.5 py-1.5 rounded-lg border-2 text-xs font-bold transition-colors ${
                  selected ? style.selected : 'border-slate-200 bg-white text-slate-600'
                }`}
              >
                {type}
              </button>
            );
          })}
        </div>
      )}
    </div>

    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label className="block text-xs font-bold text-slate-700 mb-1.5">
          연락처 <span className="font-normal text-slate-400">(선택)</span>
        </label>
        <input
          type="tel"
          value={draft.phone}
          onChange={(e) => onChange({ ...draft, phone: e.target.value })}
          placeholder="예: 010-1234-5678"
          maxLength={20}
          inputMode="tel"
          className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div>
        <label className="block text-xs font-bold text-slate-700 mb-1.5">
          담당지역 <span className="font-normal text-slate-400">(선택)</span>
        </label>
        <input
          type="text"
          value={draft.region}
          onChange={(e) => onChange({ ...draft, region: e.target.value })}
          placeholder="예: 경기 남부"
          maxLength={40}
          className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
    </div>
  </>
);

const Banner: React.FC<{
  tone: 'error' | 'success';
  onClose: () => void;
  children: React.ReactNode;
}> = ({ tone, onClose, children }) => (
  <div
    className={`flex items-start gap-2 p-3 rounded-lg border text-xs mb-4 ${
      tone === 'error'
        ? 'bg-red-50 border-red-200 text-red-800'
        : 'bg-emerald-50 border-emerald-200 text-emerald-800'
    }`}
  >
    {tone === 'error' && <XCircle className="w-4 h-4 shrink-0 mt-0.5" />}
    <span className="flex-1">{children}</span>
    <button type="button" onClick={onClose}>
      <X className="w-3.5 h-3.5" />
    </button>
  </div>
);

/**
 * Shown when a 업체 관리자 tries to delete. Rather than a dead end, it composes
 * the request so the master gets everything needed to act on it.
 */
const DeleteRequestDialog: React.FC<{
  technician: Technician;
  emails: string[];
  requesterName: string;
  onClose: () => void;
}> = ({ technician, emails, requesterName, onClose }) => {
  const subject = `[시공기사 삭제 요청] ${technician.name} (${technician.title})`;
  const body = [
    '아래 시공기사를 명부에서 삭제 요청합니다.',
    '',
    `· 이름: ${technician.name}`,
    `· 직함: ${technician.title}`,
    `· 소속 업체: ${technician.constructionTypes.join(', ') || '미지정'}`,
    `· 요청자: ${requesterName}`,
    `· 요청일: ${new Date().toLocaleDateString('ko-KR')}`,
    '',
    '사유: ',
  ].join('\n');

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl max-w-md w-full p-5 sm:p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-4">
          <span className="p-2.5 rounded-lg bg-amber-100 text-amber-700 shrink-0">
            <Mail className="w-5 h-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-bold text-slate-900">삭제는 마스터관리자만 가능합니다</h3>
            <p className="text-xs text-slate-500 mt-1">
              명부의 기사는 과거 제출 기록과 연결되어 있어, 삭제는 마스터관리자가 확인 후
              처리합니다.
            </p>
          </div>
        </div>

        <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 mb-4 text-xs">
          <p className="font-bold text-slate-800">
            {technician.name}{' '}
            <span className="font-semibold text-slate-500">({technician.title})</span>
          </p>
          {emails.length > 0 ? (
            <>
              <p className="text-slate-600 mt-1.5 mb-1">
                아래 {emails.length}명 모두에게 요청 메일이 전송됩니다:
              </p>
              <ul className="space-y-0.5">
                {emails.map((address) => (
                  <li key={address} className="flex items-center gap-1.5">
                    <Mail className="w-3 h-3 text-slate-400 shrink-0" />
                    <span className="font-semibold text-slate-700 truncate">{address}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-slate-600 mt-1.5">
              수신 메일 주소가 아직 설정되지 않았습니다. 마스터관리자에게 직접 문의해 주세요.
            </p>
          )}
        </div>

        <div className="flex gap-2">
          {emails.length > 0 && (
            <a
              href={`mailto:${emails.join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold"
            >
              <Mail className="w-3.5 h-3.5" />
              메일 작성 ({emails.length}명)
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-bold text-slate-700"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
};
