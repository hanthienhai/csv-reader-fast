// Preloaded with --import by tools/bench.mjs: prints the process's CPU time (user + system, every thread) at exit.
import { writeSync } from 'node:fs';
process.on('exit', () => {
  const u = process.cpuUsage();
  writeSync(2, `\nCPU_US=${u.user + u.system}\n`);
});
