import { GraphClient } from '@jg/sharepoint-core';
import { config } from './config';
import type { SiteRecord } from '../src/types';

/**
 * Sends upload-failure alerts through Microsoft Graph, reusing the same Azure
 * AD app registration as the SharePoint sync. The app needs the Mail.Send
 * application permission and a licensed sender mailbox (MAIL_SENDER).
 *
 * Alerts are best-effort: a mail failure is logged, never propagated, because
 * losing the notification must not also lose the retry.
 */
export class Mailer {
  private client: GraphClient | null = null;

  constructor() {
    if (this.isConfigured()) {
      this.client = new GraphClient(config.sharePoint);
    }
  }

  isConfigured(): boolean {
    const { sender, alertRecipients } = config.mail;
    const { tenantId, clientId, clientSecret } = config.sharePoint;
    return Boolean(sender && alertRecipients.length && tenantId && clientId && clientSecret);
  }

  private async send(subject: string, html: string): Promise<void> {
    if (!this.client) return;

    const token = await this.client.getAccessToken();
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.mail.sender)}/sendMail`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: 'HTML', content: html },
            toRecipients: config.mail.alertRecipients.map((address) => ({
              emailAddress: { address },
            })),
          },
          saveToSentItems: false,
        }),
      }
    );

    if (!res.ok) {
      throw new Error(`Graph sendMail 실패: ${res.status} ${await res.text().catch(() => '')}`);
    }
  }

  /** Notifies the admins that a submission could not be filed. */
  async notifyUploadFailure(record: SiteRecord, errors: string[]): Promise<void> {
    if (!this.isConfigured()) return;

    const failed = record.files.filter((file) => file.status === 'failed');
    const link = config.mail.appUrl ? `${config.mail.appUrl}/` : null;

    const subject =
      record.status === 'FAILED'
        ? `[시공자료] 업로드 실패 — ${record.constructionType} / ${record.address}`
        : `[시공자료] 일부 파일 저장 실패 — ${record.constructionType} / ${record.address}`;

    const rows: Array<[string, string]> = [
      ['시공종류', record.constructionType],
      ['현장 주소', record.address],
      ['시공기사', record.managerName],
      ['시공일', record.constructionDate],
      ['현장 ID', record.id],
      ['접수 시각', new Date(record.createdAt).toLocaleString('ko-KR')],
      ['저장 경로', record.folderPath],
      ['첨부 파일', `총 ${record.files.length}개 중 ${failed.length}개 실패`],
    ];

    await this.send(
      subject,
      `
        <div style="font-family:Malgun Gothic,sans-serif;font-size:14px;color:#0f172a">
          <h2 style="margin:0 0 4px">시공현장 자료 저장 실패</h2>
          <p style="margin:0 0 16px;color:#475569">
            제출은 정상 접수되었으나 저장소 반영에 실패했습니다. 관리자 화면에서 재동기화해 주세요.
          </p>
          <table cellpadding="6" style="border-collapse:collapse;font-size:13px">
            ${rows
              .map(
                ([label, value]) => `
              <tr>
                <td style="background:#f1f5f9;font-weight:bold;white-space:nowrap">${escapeHtml(label)}</td>
                <td>${escapeHtml(value)}</td>
              </tr>`
              )
              .join('')}
          </table>
          ${
            errors.length
              ? `<h3 style="margin:20px 0 6px;font-size:14px">오류 내용</h3>
                 <ul style="margin:0;padding-left:18px;color:#b91c1c;font-size:12px">
                   ${errors.slice(0, 20).map((error) => `<li>${escapeHtml(error)}</li>`).join('')}
                 </ul>`
              : ''
          }
          ${
            link
              ? `<p style="margin-top:20px">
                   <a href="${escapeHtml(link)}" style="color:#2563eb">관리자 화면 열기</a>
                 </p>`
              : ''
          }
        </div>
      `
    );
  }

  /** Wraps notifyUploadFailure so callers never have to guard the alert path. */
  async notifyQuietly(record: SiteRecord, errors: string[]): Promise<void> {
    try {
      await this.notifyUploadFailure(record, errors);
    } catch (err) {
      console.error('[mail] 실패 알림 메일 발송 실패', err);
    }
  }
}

function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const mailer = new Mailer();
