// The null entry the timing heat nets every run against: start, write an empty output, end.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.MAKEFUN_OUTPUT_DIR ?? '/output', 'answers.json'), '[]');
