import { createServer } from './index.js';
import { isSeeded, seedDatabase } from './seed.js';

const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '127.0.0.1';

if (process.env.TV_AUTOSEED !== 'false' && !isSeeded()) {
  const result = seedDatabase();
  if (result.seeded) console.log('[timevault] 已生成演示数据');
}

const server = createServer();
server.listen(port, host, () => {
  console.log(`[timevault] 服务已启动 http://${host}:${port}`);
});
