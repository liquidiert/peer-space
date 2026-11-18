// DEV ONLY: screenshot the art gallery page with headless Chrome.
// Assumes the vite dev server is already running at http://localhost:5199.
// Usage: node scripts/art-shot.mjs <absolute-output.png> [zoom] [width] [height]
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const [, , outArg, zoomArg = '1', widthArg = '1400', heightArg = '1000'] = process.argv;
if (!outArg) {
  console.error('usage: node scripts/art-shot.mjs <absolute-output.png> [zoom] [width] [height]');
  process.exit(1);
}
const out = path.resolve(outArg);
const url = `http://localhost:5199/art-gallery.html?zoom=${encodeURIComponent(zoomArg)}`;

execFileSync(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${widthArg},${heightArg}`,
    '--virtual-time-budget=4000',
    `--screenshot=${out}`,
    url,
  ],
  { stdio: ['ignore', 'ignore', 'inherit'], timeout: 120000 },
);
console.log(`wrote ${out} (zoom ${zoomArg})`);
