// Express 앱: 헬스 체크와 (운영) 화면 정적 빌드 + SPA 대체 경로.
import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';

export interface AppOptions {
  /** 정적 빌드 디렉터리. 없거나 존재하지 않으면 정적 제공 안 함 */
  clientDist?: string | null;
}

export function createApp(opts: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === '1');

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  const dist = opts.clientDist;
  if (dist && fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    const indexHtml = path.join(dist, 'index.html');
    // SPA 대체: GET + HTML 요청은 index.html
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/socket.io')) return next();
      if (!req.accepts('html')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ ok: false });
  });
  return app;
}
