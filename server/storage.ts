import fs from 'fs';
import path from 'path';
import { SiteRecord, SiteFile } from '../src/types';
import { sharePointService, generateSharePointFolderPath, sanitizeFolderName } from './sharepoint';

const DATA_DIR = path.join(process.cwd(), 'data');
const SITES_FILE = path.join(DATA_DIR, 'sites.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

class StorageService {
  private sites: SiteRecord[] = [];

  constructor() {
    this.loadSites();
  }

  private loadSites() {
    try {
      if (fs.existsSync(SITES_FILE)) {
        const raw = fs.readFileSync(SITES_FILE, 'utf-8');
        this.sites = JSON.parse(raw);
      } else {
        // Initial sample seed data for smooth first-run admin evaluation
        this.sites = this.getInitialSampleSites();
        this.saveSitesToDisk();
      }
    } catch (e) {
      console.error('Error loading sites:', e);
      this.sites = this.getInitialSampleSites();
    }
  }

  private saveSitesToDisk() {
    try {
      fs.writeFileSync(SITES_FILE, JSON.stringify(this.sites, null, 2), 'utf-8');
    } catch (e) {
      console.error('Error saving sites to disk:', e);
    }
  }

  private getInitialSampleSites(): SiteRecord[] {
    const date1 = '2026-08-14';
    const folder1 = generateSharePointFolderPath(date1, '경기 광명시 하안로 60 광명SK테크노파크 A동 702호', '홍길동');
    
    const date2 = '2026-08-12';
    const folder2 = generateSharePointFolderPath(date2, '서울 강남구 테헤란로 152 강남파이낸스센터 18층', '김철수');

    return [
      {
        id: 'SITE-20260814-001',
        managerName: '홍길동',
        address: '경기 광명시 하안로 60 광명SK테크노파크 A동 702호',
        constructionDate: '2026-08-14',
        notes: '외벽 방수 실링 및 창호 코킹 마감 작업 완료. 실리콘 경화 후 2차 점검 필요.',
        createdAt: '2026-08-14T09:30:00.000Z',
        status: 'COMPLETED',
        sharePointFolderPath: folder1.fullFolderPath,
        sharePointStatus: 'TEST_MODE',
        sharePointDetails: {
          syncedAt: '2026-08-14T09:30:05.000Z',
          message: '테스트 저장 모드: SharePoint 규격 폴더에 성공적으로 동기화되었습니다.',
        },
        files: [
          {
            id: 'file-001',
            originalName: 'photo_01_외벽코킹시공전.jpg',
            fileType: 'image',
            mimeType: 'image/jpeg',
            size: 2450000,
            sizeFormatted: '2.3 MB',
            storagePath: 'https://images.unsplash.com/photo-1541888946425-d0fbb18086f6?w=800&q=80',
            thumbnailUrl: 'https://images.unsplash.com/photo-1541888946425-d0fbb18086f6?w=300&q=80',
            status: 'completed',
            sharePointFilePath: `${folder1.attachmentsFolderPath}/photo_01_외벽코킹시공전.jpg`,
          },
          {
            id: 'file-002',
            originalName: 'photo_02_창호마감완료.jpg',
            fileType: 'image',
            mimeType: 'image/jpeg',
            size: 3120000,
            sizeFormatted: '3.0 MB',
            storagePath: 'https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=800&q=80',
            thumbnailUrl: 'https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=300&q=80',
            status: 'completed',
            sharePointFilePath: `${folder1.attachmentsFolderPath}/photo_02_창호마감완료.jpg`,
          }
        ]
      },
      {
        id: 'SITE-20260812-002',
        managerName: '김철수',
        address: '서울 강남구 테헤란로 152 강남파이낸스센터 18층',
        constructionDate: '2026-08-12',
        notes: '사무실 내부 파티션 철거 및 바닥 타일 교체 시공. 폐기물 반출 완료.',
        createdAt: '2026-08-12T16:15:00.000Z',
        status: 'COMPLETED',
        sharePointFolderPath: folder2.fullFolderPath,
        sharePointStatus: 'TEST_MODE',
        sharePointDetails: {
          syncedAt: '2026-08-12T16:15:04.000Z',
          message: '테스트 저장 모드: SharePoint 규격 폴더에 성공적으로 동기화되었습니다.',
        },
        files: [
          {
            id: 'file-003',
            originalName: 'photo_03_바닥타일시공.jpg',
            fileType: 'image',
            mimeType: 'image/jpeg',
            size: 1980000,
            sizeFormatted: '1.9 MB',
            storagePath: 'https://images.unsplash.com/photo-1581094794329-c8112a89af12?w=800&q=80',
            thumbnailUrl: 'https://images.unsplash.com/photo-1581094794329-c8112a89af12?w=300&q=80',
            status: 'completed',
            sharePointFilePath: `${folder2.attachmentsFolderPath}/photo_03_바닥타일시공.jpg`,
          }
        ]
      }
    ];
  }

  public getAllSites(): SiteRecord[] {
    // Return sorted newest first
    return [...this.sites].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  public getSiteById(id: string): SiteRecord | undefined {
    return this.sites.find((s) => s.id === id);
  }

  public async createSite(
    metadata: {
      managerName: string;
      address: string;
      constructionDate: string;
      notes?: string;
    },
    uploadedFiles: Express.Multer.File[]
  ): Promise<SiteRecord> {
    // Generate unique ID
    const dateStr = metadata.constructionDate.replace(/-/g, '') || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    const siteId = `SITE-${dateStr}-${randomSuffix}`;
    const createdAt = new Date().toISOString();

    const siteUploadsDir = path.join(UPLOADS_DIR, siteId);
    fs.mkdirSync(siteUploadsDir, { recursive: true });

    const folderInfo = generateSharePointFolderPath(
      metadata.constructionDate,
      metadata.address,
      metadata.managerName
    );

    const siteFiles: SiteFile[] = [];
    const filesToSync: Array<{
      id: string;
      originalName: string;
      filePath: string;
      fileType: string;
      size: number;
    }> = [];

    // Process each uploaded file
    for (let i = 0; i < uploadedFiles.length; i++) {
      const file = uploadedFiles[i];
      const fileId = `file-${siteId}-${i + 1}`;
      
      // Determine file type
      const isImage = file.mimetype.startsWith('image/');
      const isVideo = file.mimetype.startsWith('video/');
      const fileType = isImage ? 'image' : isVideo ? 'video' : 'other';

      // Keep safe filename
      const safeFilename = `${String(i + 1).padStart(2, '0')}_${sanitizeFolderName(file.originalname)}`;
      const targetFilePath = path.join(siteUploadsDir, safeFilename);

      // Write file buffer to storage
      fs.writeFileSync(targetFilePath, file.buffer);

      const storagePath = `/api/uploads/${siteId}/${encodeURIComponent(safeFilename)}`;
      const sharePointFilePath = `${folderInfo.attachmentsFolderPath}/${safeFilename}`;

      siteFiles.push({
        id: fileId,
        originalName: file.originalname,
        fileType,
        mimeType: file.mimetype,
        size: file.size,
        sizeFormatted: formatBytes(file.size),
        storagePath,
        thumbnailUrl: isImage ? storagePath : undefined,
        status: 'completed',
        sharePointFilePath,
      });

      filesToSync.push({
        id: fileId,
        originalName: safeFilename,
        filePath: targetFilePath,
        fileType,
        size: file.size,
      });
    }

    // Prepare base record
    const siteRecord: SiteRecord = {
      id: siteId,
      managerName: metadata.managerName.trim(),
      address: metadata.address.trim(),
      constructionDate: metadata.constructionDate,
      notes: metadata.notes?.trim() || '',
      createdAt,
      status: 'PENDING',
      sharePointFolderPath: folderInfo.fullFolderPath,
      sharePointStatus: 'PENDING',
      files: siteFiles,
    };

    // Trigger SharePoint Sync (Live or Test Mode)
    const syncResult = await sharePointService.syncSiteToSharePoint(
      {
        id: siteRecord.id,
        managerName: siteRecord.managerName,
        address: siteRecord.address,
        constructionDate: siteRecord.constructionDate,
        notes: siteRecord.notes,
        createdAt: siteRecord.createdAt,
        sharePointFolderPath: folderInfo.fullFolderPath,
      },
      filesToSync
    );

    siteRecord.status = syncResult.success ? 'COMPLETED' : 'FAILED';
    siteRecord.sharePointStatus = syncResult.mode === 'LIVE' ? (syncResult.success ? 'SYNCED' : 'FAILED') : 'TEST_MODE';
    siteRecord.sharePointDetails = {
      syncedAt: new Date().toISOString(),
      message: syncResult.message,
      webUrl: syncResult.webUrl,
    };

    this.sites.unshift(siteRecord);
    this.saveSitesToDisk();

    return siteRecord;
  }

  public async retrySharePointSync(siteId: string): Promise<SiteRecord | null> {
    const site = this.getSiteById(siteId);
    if (!site) return null;

    const siteUploadsDir = path.join(UPLOADS_DIR, siteId);
    const filesToSync: Array<{
      id: string;
      originalName: string;
      filePath: string;
      fileType: string;
      size: number;
    }> = [];

    site.files.forEach((f, idx) => {
      const safeFilename = `${String(idx + 1).padStart(2, '0')}_${sanitizeFolderName(f.originalName)}`;
      const filePath = path.join(siteUploadsDir, safeFilename);
      if (fs.existsSync(filePath)) {
        filesToSync.push({
          id: f.id,
          originalName: safeFilename,
          filePath,
          fileType: f.fileType,
          size: f.size,
        });
      }
    });

    const syncResult = await sharePointService.syncSiteToSharePoint(
      {
        id: site.id,
        managerName: site.managerName,
        address: site.address,
        constructionDate: site.constructionDate,
        notes: site.notes,
        createdAt: site.createdAt,
        sharePointFolderPath: site.sharePointFolderPath,
      },
      filesToSync
    );

    site.sharePointStatus = syncResult.mode === 'LIVE' ? (syncResult.success ? 'SYNCED' : 'FAILED') : 'TEST_MODE';
    site.sharePointDetails = {
      syncedAt: new Date().toISOString(),
      message: syncResult.message,
      webUrl: syncResult.webUrl,
    };
    if (syncResult.success) {
      site.status = 'COMPLETED';
    }

    this.saveSitesToDisk();
    return site;
  }
}

export const storageService = new StorageService();
