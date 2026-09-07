import path from 'path';
import { sanitizeFileName } from '@jg/sharepoint-core';
import type { SharePointService } from '@jg/sharepoint-core';
import { config } from './config';
import type { Repositories } from './repositories';
import type { SiteFile, SiteRecord, SiteTechnician } from '../src/types';
import { classifyFile, formatBytes, generateId } from './util';

export interface SubmissionInput {
  siteId: string;
  constructionType: string;
  siteType?: string;
  customerName?: string;
  customFields?: SiteRecord['customFields'];
  /** 목록에서 고른 시공건. 직접 입력으로 제출하면 없습니다. */
  workOrderId?: string;
  /** Roster entries chosen on the form; at least one. */
  technicians: SiteTechnician[];
  /** technicians rendered as one string — folder token and display. */
  managerName: string;
  address: string;
  constructionDate: string;
  notes: string;
  clientIp: string;
  userAgent: string;
}

/** Directory holding one submission's attachments while they await upload. */
export function stagingDirFor(siteId: string): string {
  return path.join(config.paths.staging, siteId);
}

/**
 * Numbered, sanitized name written to the library. The index prefix keeps the
 * submitter's ordering visible in a folder listing and prevents two identically
 * named photos from overwriting each other.
 *
 * Multer uses this for the staged copy as well, but the two numberings are not
 * guaranteed to agree — see SiteFile.stagedName. The staged copy is located by
 * the name multer reported, and only the destination name comes from here.
 */
export function storedNameFor(index: number, originalName: string): string {
  return `${String(index + 1).padStart(2, '0')}_${sanitizeFileName(originalName)}`;
}

/**
 * Accepts a submission and hands it off.
 *
 * This deliberately performs no network I/O. The attachments are already staged
 * on disk by multer, so the record is written and the submitter gets their
 * confirmation straight away; filing the files into the document library — which
 * can take minutes for large videos — happens afterwards on the worker.
 */
export class SubmissionIntake {
  constructor(
    private readonly repos: Repositories,
    private readonly sharePoint: SharePointService
  ) {}

  async accept(input: SubmissionInput, files: Express.Multer.File[]): Promise<SiteRecord> {
    const createdAt = new Date().toISOString();

    const submission = {
      id: input.siteId,
      constructionType: input.constructionType,
      siteType: input.siteType,
      customerName: input.customerName,
      customFields: input.customFields,
      workOrderId: input.workOrderId,
      technicians: input.technicians,
      managerName: input.managerName,
      address: input.address,
      constructionDate: input.constructionDate,
      notes: input.notes,
      createdAt,
    };

    // Resolved up front so the destination is visible while still queued, and
    // so a rule change mid-flight cannot split one submission across layouts.
    const folders = this.sharePoint.planFolders(submission);

    const record: SiteRecord = {
      ...submission,
      status: 'QUEUED',
      storageMode: this.sharePoint.getConfigStatus().mode,
      folderPath: folders.fullFolderPath,
      attachmentsFolderPath: folders.attachmentsFolderPath,
      syncMessage: '접수 완료. 저장소 반영을 준비하고 있습니다.',
      retryAvailable: true,
      attempts: 0,
      files: files.map<SiteFile>((file, index) => ({
        id: generateId('file'),
        originalName: file.originalname,
        storedName: storedNameFor(index, file.originalname),
        // What multer actually wrote, straight from multer — never recomputed.
        stagedName: file.filename,
        fileType: classifyFile(file.mimetype),
        mimeType: file.mimetype,
        size: file.size,
        sizeFormatted: formatBytes(file.size),
        status: 'pending',
      })),
    };

    await this.repos.sites.save(record);
    return record;
  }
}
