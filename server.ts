import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { storageService } from './server/storage';
import { sharePointService } from './server/sharepoint';

async function startServer() {
  const app = express();
  const PORT = 3000;

  // JSON and urlencoded body parser
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Multer configuration for memory storage or buffer handling
  // Max 50 files, max 100MB each
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 100 * 1024 * 1024, // 100MB
      files: 50,
    },
    fileFilter: (_req, file, cb) => {
      // Validate photo or video formats
      const isImage = file.mimetype.startsWith('image/');
      const isVideo = file.mimetype.startsWith('video/');
      if (isImage || isVideo) {
        cb(null, true);
      } else {
        cb(new Error(`지원되지 않는 파일 형식입니다 (${file.originalname}). 사진 또는 동영상 파일만 업로드 가능합니다.`));
      }
    },
  });

  // --- API Endpoints ---

  // 1. Health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // 2. Get SharePoint Configuration Status
  app.get('/api/sharepoint/status', (_req, res) => {
    try {
      const status = sharePointService.getConfigStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'SharePoint 상태 확인 실패' });
    }
  });

  // 3. Get all sites list (for Admin)
  app.get('/api/sites', (_req, res) => {
    try {
      const sites = storageService.getAllSites();
      res.json({ sites });
    } catch (err: any) {
      res.status(500).json({ error: '현장 목록 조회 실패', details: err.message });
    }
  });

  // 4. Get single site detail
  app.get('/api/sites/:id', (req, res) => {
    try {
      const site = storageService.getSiteById(req.params.id);
      if (!site) {
        return res.status(404).json({ error: '요청한 현장을 찾을 수 없습니다.' });
      }
      res.json({ site });
    } catch (err: any) {
      res.status(500).json({ error: '현장 상세 조회 실패', details: err.message });
    }
  });

  // 5. Submit new site and files
  app.post(
    '/api/sites',
    (req, res, next) => {
      upload.array('files', 50)(req, res, (err) => {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
              error: '파일 용량 초과',
              message: '파일 1개의 최대 용량은 100MB입니다. 100MB 이하의 파일만 선택해 주세요.',
            });
          }
          if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({
              error: '파일 개수 초과',
              message: '파일은 최대 50개까지 업로드할 수 있습니다.',
            });
          }
          return res.status(400).json({
            error: '파일 업로드 오류',
            message: err.message,
          });
        } else if (err) {
          return res.status(400).json({
            error: '입력 검증 오류',
            message: err.message,
          });
        }
        next();
      });
    },
    async (req, res) => {
      try {
        const { managerName, address, constructionDate, notes } = req.body;

        // Validation
        if (!managerName || !managerName.trim()) {
          return res.status(400).json({
            error: '필수 입력 누락',
            message: '담당자 이름을 입력해 주세요.',
          });
        }

        if (!address || !address.trim()) {
          return res.status(400).json({
            error: '필수 입력 누락',
            message: '현장 주소를 입력해 주세요.',
          });
        }

        if (!constructionDate || !constructionDate.trim()) {
          return res.status(400).json({
            error: '필수 입력 누락',
            message: '시공일을 달력에서 선택해 주세요.',
          });
        }

        const files = (req.files as Express.Multer.File[]) || [];

        if (files.length > 50) {
          return res.status(400).json({
            error: '파일 개수 초과',
            message: '첨부파일은 최대 50개까지만 업로드 가능합니다.',
          });
        }

        // Save site data and sync to SharePoint
        const siteRecord = await storageService.createSite(
          {
            managerName,
            address,
            constructionDate,
            notes: notes || '',
          },
          files
        );

        res.status(201).json({
          success: true,
          message: '현장자료가 성공적으로 등록 및 저장되었습니다.',
          site: siteRecord,
        });
      } catch (err: any) {
        console.error('Error creating site:', err);
        res.status(500).json({
          error: '현장자료 저장 실패',
          message: err.message || '서버 내부 오류로 현장자료 저장에 실패했습니다.',
        });
      }
    }
  );

  // 6. Retry SharePoint sync for a site
  app.post('/api/sites/:id/retry-sharepoint', async (req, res) => {
    try {
      const site = await storageService.retrySharePointSync(req.params.id);
      if (!site) {
        return res.status(404).json({ error: '현장을 찾을 수 없습니다.' });
      }
      res.json({ success: true, site });
    } catch (err: any) {
      res.status(500).json({ error: 'SharePoint 재동기화 실패', details: err.message });
    }
  });

  // 7. Serve uploaded files with support for streaming/range requests (for videos)
  app.get('/api/uploads/:siteId/:filename', (req, res) => {
    const { siteId, filename } = req.params;
    const filePath = path.join(process.cwd(), 'data', 'uploads', siteId, decodeURIComponent(filename));

    if (!fs.existsSync(filePath)) {
      return res.status(404).send('파일을 찾을 수 없습니다.');
    }

    res.sendFile(filePath);
  });

  // 8. Serve SharePoint Simulated Folder tree
  app.get('/api/sharepoint/preview-tree', (_req, res) => {
    const spDir = path.join(process.cwd(), 'data', 'sharepoint_storage');
    function getTree(dir: string, rel = ''): any[] {
      if (!fs.existsSync(dir)) return [];
      const items = fs.readdirSync(dir);
      return items.map((item) => {
        const full = path.join(dir, item);
        const itemRel = rel ? `${rel}/${item}` : item;
        const isDir = fs.statSync(full).isDirectory();
        return {
          name: item,
          path: itemRel,
          type: isDir ? 'folder' : 'file',
          children: isDir ? getTree(full, itemRel) : undefined,
          size: isDir ? undefined : fs.statSync(full).size,
        };
      });
    }

    const tree = getTree(spDir);
    res.json({ rootFolder: '시공현장자료', tree });
  });

  // --- Vite Dev & Production Static Middleware ---
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Construction Site Management Server running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
