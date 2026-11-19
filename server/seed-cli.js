import { seedDatabase } from './seed.js';

const force = process.argv.includes('--force');
const result = seedDatabase({ force });
if (result.seeded) console.log('演示数据已生成');
else console.log(`跳过：${result.reason ?? '未知原因'}（使用 --force 强制重建）`);
