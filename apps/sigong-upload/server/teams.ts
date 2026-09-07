import { formatTechnicians } from '../src/types';
import type { SiteRecord } from '../src/types';

/**
 * Teams channel notification for a finished submission.
 *
 * Posted by this app rather than by a SharePoint flow watching the folder. The
 * difference matters: a folder watcher fires the moment a file appears, which is
 * before anything has been verified — and a submission whose files were renamed
 * away by a library rule would still announce itself as a success. Here the card
 * goes out only after the destination has been read back, so what it reports is
 * what is actually stored.
 *
 * The endpoint is a Teams **Workflows** webhook ("Post to a channel when a
 * webhook request is received"), which accepts the same payload shape the older
 * Office 365 connectors did.
 */

const TIMEOUT_MS = 10_000;

export interface TeamsCardResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Teams renders these three states differently, so name them once. */
type Tone = 'good' | 'warning' | 'attention';

function toneFor(status: SiteRecord['status']): { tone: Tone; label: string; icon: string } {
  if (status === 'COMPLETED') return { tone: 'good', label: '저장 완료', icon: '✅' };
  if (status === 'PARTIAL') return { tone: 'warning', label: '일부 저장 실패', icon: '⚠️' };
  return { tone: 'attention', label: '저장 실패', icon: '🚨' };
}

function factSet(pairs: [string, string][]) {
  return {
    type: 'FactSet',
    facts: pairs
      .filter(([, value]) => value)
      .map(([title, value]) => ({ title, value })),
  };
}

/**
 * Builds the Adaptive Card.
 *
 * Kept to the facts a channel reader can act on — who, what, where, and whether
 * anything is missing. The stored-file count is the verified count, not the
 * number that was uploaded, so a mismatch is visible in the channel instead of
 * being discovered weeks later in SharePoint.
 */
export function buildCard(record: SiteRecord, folderUrl?: string) {
  const { tone, label, icon } = toneFor(record.status);
  const stored = record.files.filter((file) => file.status === 'completed').length;
  const total = record.files.length;
  const failed = record.files.filter((file) => file.status === 'failed');

  const body: unknown[] = [
    {
      type: 'TextBlock',
      text: `${icon} 시공자료 제출 · ${record.constructionType}`,
      weight: 'Bolder',
      size: 'Medium',
      wrap: true,
    },
    // A tinted band rather than coloured text. A channel is skimmed, not read,
    // and the one thing that must survive a glance is whether this needs
    // attention — green for stored, red for not.
    {
      type: 'Container',
      style: tone,
      bleed: true,
      items: [
        {
          type: 'ColumnSet',
          columns: [
            {
              type: 'Column',
              width: 'stretch',
              items: [
                {
                  type: 'TextBlock',
                  text: `업로드 상태 · ${label}`,
                  weight: 'Bolder',
                  size: 'Medium',
                  color: tone === 'good' ? 'Good' : tone === 'warning' ? 'Warning' : 'Attention',
                  wrap: true,
                },
              ],
            },
            {
              type: 'Column',
              width: 'auto',
              items: [
                {
                  type: 'TextBlock',
                  text: stored === total ? `${total} / ${total}` : `${stored} / ${total}`,
                  weight: 'Bolder',
                  size: 'Medium',
                  color: tone === 'good' ? 'Good' : 'Attention',
                },
              ],
            },
          ],
        },
      ],
    },
    factSet([
      ['현장 ID', record.id],
      ['시공기사', formatTechnicians(record.technicians || []) || record.managerName],
      ['시공종류', record.constructionType],
      ...((record.customFields || []).filter((field) => field.value).map(
        (field) => [field.label, field.value] as [string, string]
      )),
      ['시공일', record.constructionDate],
      ['현장주소', record.address],
      [
        '파일',
        stored === total
          ? `${total}개 모두 저장 확인`
          : `${total}개 중 ${stored}개만 저장됨 (${total - stored}개 실패)`,
      ],
      ['특이사항', record.notes],
    ]),
  ];

  if (failed.length > 0) {
    body.push({
      type: 'TextBlock',
      text: `저장되지 않은 파일 ${failed.length}개: ${failed
        .slice(0, 5)
        .map((file) => file.originalName)
        .join(', ')}${failed.length > 5 ? ' 외' : ''}`,
      wrap: true,
      color: 'Attention',
      size: 'Small',
    });
  }

  if (record.folderPath) {
    body.push({
      type: 'TextBlock',
      text: `📁 ${record.folderPath.split('/').join(' / ')}`,
      wrap: true,
      isSubtle: true,
      size: 'Small',
    });
  }

  const actions = folderUrl
    ? [{ type: 'Action.OpenUrl', title: '📁 자료 폴더 열기', url: folderUrl }]
    : [];

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body,
          ...(actions.length ? { actions } : {}),
        },
      },
    ],
  };
}

export class TeamsNotifier {
  /**
   * Posts one card. Never throws: a channel notification failing must not turn
   * a stored submission into a failed one.
   */
  async post(webhookUrl: string, payload: unknown): Promise<TeamsCardResult> {
    if (!webhookUrl) return { ok: false, error: '알림 주소가 설정되지 않았습니다.' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: detail.slice(0, 300) || `HTTP ${res.status}` };
      }
      return { ok: true, status: res.status };
    } catch (err: any) {
      return {
        ok: false,
        error: err?.name === 'AbortError' ? '응답 시간이 초과되었습니다.' : String(err?.message || err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fire-and-forget notification for a finished submission. */
  async notifyQuietly(webhookUrl: string, record: SiteRecord): Promise<void> {
    if (!webhookUrl) return;

    const result = await this.post(webhookUrl, buildCard(record, record.webUrl));
    if (!result.ok) {
      console.error(`[teams] 알림 전송 실패 (${record.id})`, result.error);
    }
  }
}

export const teams = new TeamsNotifier();
