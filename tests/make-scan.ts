import * as ops from '../src/lib/ops';
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync('tests/out/scan.pdf', await ops.imagesToPdf([{ bytes: readFileSync('tests/out/scan-1.png'), type: 'image/png' }], [612, 792]));
