// 서버 진입점: Express + HTTP 서버 + Socket.IO를 같은 포트에서 제공한다.
// https://socket.io/docs/v4/server-initialization/#with-express
import http from 'node:http';
import path from 'node:path';
import { createApp } from './app';
import { createGameServer, type GameServerTimings } from './gameServer';

const isProd = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

// 운영: ALLOWED_ORIGIN(쉼표 구분) + 같은 호스트만. 개발: Vite 개발 서버 + 같은 호스트.
const envOrigins = (process.env.ALLOWED_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const allowedOrigins = isProd
  ? envOrigins
  : [...envOrigins, 'http://localhost:5173', 'http://127.0.0.1:5173'];

const clientDist = process.env.CLIENT_DIST ?? path.resolve(process.cwd(), 'dist/client');
const app = createApp({ clientDist: isProd || process.env.SERVE_CLIENT === '1' ? clientDist : null });
const httpServer = http.createServer(app);
// 선택: 테스트·시연용 시간 단축 (초 단위, 양수만 반영). 기본값은 규칙 상수(낮 45초·밤 결과 8초).
const envSeconds = (name: string): number | undefined => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v * 1000 : undefined;
};
const timings: Partial<GameServerTimings> = {};
const dayMs = envSeconds('DAY_SECONDS');
const nightResultMs = envSeconds('NIGHT_RESULT_SECONDS');
const hostGraceMs = envSeconds('HOST_GRACE_SECONDS');
if (dayMs) timings.dayMs = dayMs;
if (nightResultMs) timings.nightResultMs = nightResultMs;
if (hostGraceMs) timings.hostGraceMs = hostGraceMs;
if (Object.keys(timings).length > 0) console.log('[server] timing overrides', timings);

const game = createGameServer({
  httpServer,
  timings,
  allowedOrigins,
  trustProxy: process.env.TRUST_PROXY === '1',
});

game.listen(port, host).then((p) => {
  console.log(`[server] listening on http://${host}:${p} (${isProd ? 'production' : 'development'})`);
});

const shutdown = () => {
  game.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
