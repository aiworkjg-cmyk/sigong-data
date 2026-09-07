import fs from 'fs';
import path from 'path';
import { config } from './config';

/**
 * 앱을 거치지 않은 SharePoint 변경 기록.
 *
 * 업로드 로그와 갈라 놓은 이유가 분명합니다. 업로드 로그는 "이 사이트를 통해
 * 누가 무엇을 올렸는가"를 답하는 업무 기록이고, 그 안에 사람이 SharePoint 에서
 * 직접 지운 사건이 섞이면 두 질문 모두 답하기 어려워집니다. 실제로 삭제 기록이
 * "실패" 로 뒤섞여 업로드 로그가 읽을 수 없게 되어 있었습니다.
 *
 * 형식은 JSONL(한 줄에 한 건)입니다. 추가만 하고 고치지 않으므로 파일이 깨질
 * 여지가 적고, 문제가 생겼을 때 텍스트 도구로 바로 훑어볼 수 있습니다. 감사
 * 기록에 필요한 성질은 화려한 조회가 아니라 "지워지지 않는다" 입니다.
 */

export type ManualAuditAction = 'ADDED' | 'DELETED' | 'RENAMED';

export interface ManualAuditEntry {
  at: string;
  action: ManualAuditAction;
  /** 라이브러리 안의 경로. 앱이 관리하는 폴더 아래만 기록합니다. */
  path: string;
  name: string;
  /** Graph 가 알려 준 마지막 수정자. 모르면 빈 문자열입니다. */
  by: string;
  itemId: string;
  note: string;
}

/** 한 파일이 무한정 커지지 않도록 월 단위로 나눕니다. */
function fileFor(at: Date): string {
  const month = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;
  return path.join(config.paths.jsonStore, `manual-audit-${month}.jsonl`);
}

/**
 * 한 건을 덧붙입니다.
 *
 * 실패해도 던지지 않습니다 — 기록을 남기지 못했다고 해서 그것을 유발한 작업
 * (이름 정리·동기화)까지 멈출 이유는 없습니다. 대신 콘솔에는 남깁니다.
 */
export async function appendManualAudit(entry: ManualAuditEntry): Promise<void> {
  try {
    await fs.promises.mkdir(config.paths.jsonStore, { recursive: true });
    await fs.promises.appendFile(
      fileFor(new Date(entry.at)),
      `${JSON.stringify(entry)}\n`,
      'utf-8'
    );
  } catch (err) {
    console.error('[audit] 수동 변경 기록 실패', err);
  }
}

/** 최근 기록을 새 것부터. 월 파일을 뒤에서부터 읽습니다. */
export async function readManualAudit(limit = 500): Promise<ManualAuditEntry[]> {
  try {
    const dir = config.paths.jsonStore;
    const files = (await fs.promises.readdir(dir))
      .filter((name) => name.startsWith('manual-audit-') && name.endsWith('.jsonl'))
      .sort()
      .reverse();

    const entries: ManualAuditEntry[] = [];
    for (const name of files) {
      const text = await fs.promises.readFile(path.join(dir, name), 'utf-8');
      const lines = text.split('\n').filter(Boolean).reverse();
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as ManualAuditEntry);
        } catch {
          // 한 줄이 깨져도 나머지는 읽습니다 — 감사 기록에서 전부를 잃는 것이
          // 가장 나쁜 결과입니다.
        }
        if (entries.length >= limit) return entries;
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * 이 앱이 관리하는 폴더 아래의 경로인지.
 *
 * Graph 변경 추적은 드라이브 전체를 알려 줍니다. 그런데 이 앱이 책임지는 것은
 * 폴더 규칙이 만드는 경로뿐이고, 그 밖의 파일까지 기록하면 남의 업무 기록을
 * 그대로 옮겨 적는 셈이 됩니다. 추적 목적에도 도움이 되지 않습니다.
 */
export function isManagedPath(rawPath: string, rootFolder: string): boolean {
  const root = (rootFolder || '').replace(/^\/+|\/+$/g, '');
  if (!root) return false;

  // "/drives/{id}/root:/시공현장자료/백조/…" 에서 라이브러리 기준 경로만 남깁니다.
  const relative = (rawPath || '')
    .replace(/^\/drives\/[^/]+\/root:?/, '')
    .replace(/^\/+/, '');
  return relative === root || relative.startsWith(`${root}/`);
}

/** 표시·내보내기에 쓰는 짧은 경로. */
export function toLibraryPath(rawPath: string): string {
  return (rawPath || '').replace(/^\/drives\/[^/]+\/root:?/, '').replace(/^\/+/, '');
}
