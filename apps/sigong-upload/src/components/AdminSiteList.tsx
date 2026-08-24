import React, { useState } from 'react';
import {
  Search,
  Calendar,
  User,
  MapPin,
  Image,
  Video,
  ChevronRight,
  FolderCheck,
  RefreshCw,
  Building2,
  Filter,
  CheckCircle2,
  Clock,
  HardHat,
  FileText
} from 'lucide-react';
import { SiteRecord } from '../types';

interface AdminSiteListProps {
  sites: SiteRecord[];
  isLoading: boolean;
  onRefresh: () => void;
  onSelectSite: (siteId: string) => void;
  onGoToRegister: () => void;
}

export const AdminSiteList: React.FC<AdminSiteListProps> = ({
  sites,
  isLoading,
  onRefresh,
  onSelectSite,
  onGoToRegister,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFilter, setSelectedFilter] = useState<'all' | 'today' | 'with-files'>('all');

  const todayStr = new Date().toISOString().slice(0, 10);

  // Filter sites
  const filteredSites = sites.filter((site) => {
    const matchesSearch =
      site.managerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      site.address.toLowerCase().includes(searchQuery.toLowerCase()) ||
      site.constructionDate.includes(searchQuery) ||
      site.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (site.notes && site.notes.toLowerCase().includes(searchQuery.toLowerCase()));

    if (!matchesSearch) return false;

    if (selectedFilter === 'today') {
      return site.createdAt.startsWith(todayStr) || site.constructionDate === todayStr;
    }
    if (selectedFilter === 'with-files') {
      return site.files.length > 0;
    }
    return true;
  });

  // Aggregate stats
  const totalSites = sites.length;
  const totalFiles = sites.reduce((sum, s) => sum + s.files.length, 0);
  const totalPhotos = sites.reduce((sum, s) => sum + s.files.filter((f) => f.fileType === 'image').length, 0);
  const totalVideos = sites.reduce((sum, s) => sum + s.files.filter((f) => f.fileType === 'video').length, 0);

  return (
    <div className="max-w-7xl mx-auto py-6 sm:py-8 px-4 sm:px-6 lg:px-8">
      {/* Top Section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h2 className="text-xl sm:text-2xl font-extrabold text-slate-900 flex items-center gap-2.5">
            <Building2 className="w-6 h-6 text-blue-600" />
            시공현장 자료 관리
          </h2>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            외부에서 등록된 현장 정보 및 사진·동영상 자료를 조회하고 SharePoint 저장 상태를 확인합니다.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 shadow-2xs transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-blue-600' : ''}`} />
            <span>목록 갱신</span>
          </button>

          <button
            type="button"
            onClick={onGoToRegister}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-xs font-semibold text-white shadow-2xs transition-colors"
          >
            <HardHat className="w-3.5 h-3.5" />
            <span>새 현장 등록</span>
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
          <span className="text-xs font-medium text-slate-500">총 등록 현장</span>
          <p className="text-xl sm:text-2xl font-bold text-slate-900 mt-1">{totalSites}개소</p>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
          <span className="text-xs font-medium text-slate-500">총 첨부파일</span>
          <p className="text-xl sm:text-2xl font-bold text-blue-600 mt-1">{totalFiles}개</p>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
          <span className="text-xs font-medium text-slate-500">현장 사진</span>
          <p className="text-xl sm:text-2xl font-bold text-emerald-600 mt-1">{totalPhotos}장</p>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs">
          <span className="text-xs font-medium text-slate-500">현장 동영상</span>
          <p className="text-xl sm:text-2xl font-bold text-indigo-600 mt-1">{totalVideos}개</p>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="bg-white p-3.5 sm:p-4 rounded-xl border border-slate-200 shadow-2xs mb-6 flex flex-col sm:flex-row items-center justify-between gap-3">
        {/* Search input */}
        <div className="relative w-full sm:w-80">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
            <Search className="w-4 h-4" />
          </div>
          <input
            id="input-search-sites"
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="예: 광명 / 홍길동 / BAEKJO-20260824-001"
            className="w-full pl-9 pr-4 py-2 rounded-lg border border-slate-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 text-xs sm:text-sm focus:outline-hidden transition-all"
          />
        </div>

        {/* Filter buttons */}
        <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0 text-xs">
          <button
            type="button"
            onClick={() => setSelectedFilter('all')}
            className={`px-3 py-1.5 rounded-lg font-medium whitespace-nowrap transition-colors ${
              selectedFilter === 'all'
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            전체 ({sites.length})
          </button>
          <button
            type="button"
            onClick={() => setSelectedFilter('today')}
            className={`px-3 py-1.5 rounded-lg font-medium whitespace-nowrap transition-colors ${
              selectedFilter === 'today'
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            오늘 등록
          </button>
          <button
            type="button"
            onClick={() => setSelectedFilter('with-files')}
            className={`px-3 py-1.5 rounded-lg font-medium whitespace-nowrap transition-colors ${
              selectedFilter === 'with-files'
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            첨부자료 보유
          </button>
        </div>
      </div>

      {/* Site List: Table for desktop, Cards for mobile */}
      {filteredSites.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
          <div className="w-12 h-12 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-3">
            <Building2 className="w-6 h-6" />
          </div>
          <h4 className="text-base font-bold text-slate-700 mb-1">등록된 시공현장이 없습니다</h4>
          <p className="text-xs text-slate-500 max-w-sm mx-auto mb-4">
            {searchQuery
              ? '검색 조건과 일치하는 현장이 없습니다. 검색어를 다시 확인해 주세요.'
              : '외부 현장등록 링크를 통해 새로운 현장자료를 제출해 보세요.'}
          </p>
          <button
            type="button"
            onClick={onGoToRegister}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold"
          >
            <HardHat className="w-3.5 h-3.5" />
            <span>현장자료 등록하러 가기</span>
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Desktop Table View */}
          <div className="hidden md:block bg-white rounded-xl border border-slate-200 overflow-hidden shadow-2xs">
            <table className="w-full text-left text-xs text-slate-600">
              <thead className="bg-slate-50 text-slate-700 font-semibold border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4">시공일</th>
                  <th className="py-3 px-4">현장 주소</th>
                  <th className="py-3 px-4">시공기사</th>
                  <th className="py-3 px-4">첨부파일</th>
                  <th className="py-3 px-4">등록일시</th>
                  <th className="py-3 px-4">상태</th>
                  <th className="py-3 px-4 text-right">상세</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredSites.map((site) => {
                  const photoCnt = site.files.filter((f) => f.fileType === 'image').length;
                  const videoCnt = site.files.filter((f) => f.fileType === 'video').length;

                  return (
                    <tr
                      key={site.id}
                      onClick={() => onSelectSite(site.id)}
                      className="hover:bg-blue-50/40 cursor-pointer transition-colors"
                    >
                      {/* 시공일 */}
                      <td className="py-3.5 px-4 font-mono font-medium text-slate-900 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <Calendar className="w-3.5 h-3.5 text-slate-400" />
                          <span>{site.constructionDate}</span>
                        </div>
                      </td>

                      {/* 현장 주소 & 특이사항 */}
                      <td className="py-3.5 px-4 max-w-xs">
                        <p className="font-semibold text-slate-900 truncate" title={site.address}>
                          {site.address}
                        </p>
                        {site.notes && (
                          <p className="text-[11px] text-slate-400 truncate mt-0.5" title={site.notes}>
                            📝 {site.notes}
                          </p>
                        )}
                      </td>

                      {/* 시공기사 */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 font-medium text-slate-800">
                          <User className="w-3.5 h-3.5 text-slate-400" />
                          <span>{site.managerName}</span>
                        </div>
                      </td>

                      {/* 첨부파일 뱃지 */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-slate-800">{site.files.length}개</span>
                          {photoCnt > 0 && (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px]">
                              📷 {photoCnt}
                            </span>
                          )}
                          {videoCnt > 0 && (
                            <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px]">
                              🎥 {videoCnt}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* 등록일시 */}
                      <td className="py-3.5 px-4 text-slate-500 whitespace-nowrap">
                        {new Date(site.createdAt).toLocaleString('ko-KR', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>

                      {/* 상태 */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold ${
                            site.status === 'COMPLETED'
                              ? 'bg-emerald-100 text-emerald-800'
                              : site.status === 'FAILED'
                              ? 'bg-rose-100 text-rose-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          <CheckCircle2 className="w-3 h-3" />
                          {site.status === 'COMPLETED' ? '저장 완료' : '진행 중'}
                        </span>
                      </td>

                      {/* 상세 이동 화살표 */}
                      <td className="py-3.5 px-4 text-right">
                        <ChevronRight className="w-4 h-4 text-slate-400 inline" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile Card View */}
          <div className="md:hidden space-y-3">
            {filteredSites.map((site) => {
              const photoCnt = site.files.filter((f) => f.fileType === 'image').length;
              const videoCnt = site.files.filter((f) => f.fileType === 'video').length;

              return (
                <div
                  key={site.id}
                  onClick={() => onSelectSite(site.id)}
                  className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs active:bg-slate-50 transition-colors"
                >
                  <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
                    <span className="flex items-center gap-1 font-mono font-medium text-slate-700">
                      <Calendar className="w-3.5 h-3.5 text-blue-600" />
                      시공일: {site.constructionDate}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        site.status === 'COMPLETED'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      {site.status === 'COMPLETED' ? '저장 완료' : '처리 중'}
                    </span>
                  </div>

                  <h4 className="text-sm font-bold text-slate-900 mb-1 flex items-start gap-1.5">
                    <MapPin className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                    <span>{site.address}</span>
                  </h4>

                  {site.notes && (
                    <p className="text-xs text-slate-500 mb-3 pl-5 line-clamp-2">
                      {site.notes}
                    </p>
                  )}

                  <div className="flex items-center justify-between pt-3 border-t border-slate-100 text-xs">
                    <span className="flex items-center gap-1 text-slate-700 font-medium">
                      <User className="w-3.5 h-3.5 text-slate-400" />
                      {site.managerName}
                    </span>

                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-slate-700">
                        파일 {site.files.length}개
                      </span>
                      <ChevronRight className="w-4 h-4 text-slate-400" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
