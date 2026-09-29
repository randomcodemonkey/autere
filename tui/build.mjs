#!/usr/bin/env node
/**
 * Build the TUI as a single executable under tui/dist/.
 * Steps: esbuild bundle → Node SEA blob → inject into a copy of the node binary.
 * Requires Node >= 20 plus the `postject` dev dependency.
 */
import { execFileSync } from 'child_process';
import { copyFileSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = here;
const DIST = join(ROOT, 'dist');
const BUNDLE = join(DIST, 'autere-tui-bundle.mjs');
const BLOB = join(DIST, 'autere-tui.blob');
const SEA_CONFIG = join(DIST, 'sea-config.json');
const OUT = join(DIST, process.platform === 'win32' ? 'autere-tui.exe' : 'autere-tui');
const ESBUILD = join(require.resolve('esbuild/package.json').replace('/package.json', '/bin/esbuild'));

mkdirSync(DIST, { recursive: true });

// 1. Bundle (TSX/ESM → single ESM file with ink/react embedded; yoga-layout
// uses top-level await so CJS is not an option)
execFileSync(ESBUILD, ['index.tsx', '--bundle', '--platform=node', '--format=esm',
  '--outfile=' + BUNDLE,
  '--alias:react-devtools-core=./stub/react-devtools-core.js',
  '--banner:js=import { createRequire } from "module"; const require = createRequire(import.meta.url);'], {
  cwd: ROOT,
  stdio: 'inherit',
});

// 2. SEA blob — no SEA assets needed: backend URL/token come from flags/env at runtime
writeFileSync(SEA_CONFIG, JSON.stringify({
  main: 'dist/autere-tui-bundle.mjs',
  output: 'dist/autere-tui.blob',
  disableExperimentalSEAWarning: true,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', SEA_CONFIG], { cwd: ROOT, stdio: 'inherit' });

// 3. Copy the node binary and inject the blob (needs a node build with SEA
// support — nodejs.org builds have the sentinel fuse; some distro builds
// don't). Fall back to a `#!/usr/bin/env node` single-file script when the
// fuse is missing (ponytail: drop the fallback once SEA-capable node builds
// are standard).
if (existsSync(OUT)) rmSync(OUT, { force: true });
try {
  distroNodeCheck();
  copyFileSync(process.execPath, OUT);
  execFileSync('npx', ['postject', OUT, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', 'NODE_SEA_FUSE_cece90d558edb4ad'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  rmSync(BUNDLE, { force: true });
  rmSync(BLOB, { force: true });
  console.log('Built single executable:', OUT);
} catch (err) {
  console.warn('SEA injection failed — falling back to single-file script with shebang');
  console.warn('(true single-binary build requires a nodejs.org node: ' + (err.message || err) + ')');
  if (existsSync(OUT)) rmSync(OUT, { force: true });
  copyFileSync(BUNDLE, OUT);
  const src = readFileSync(OUT, 'utf-8');
  // esbuild keeps the source shebang (#!/usr/bin/env tsx) — replace it
  const body = src.startsWith('#!') ? src.slice(src.indexOf('\n') + 1) : src;
  writeFileSync(OUT, '#!/usr/bin/env node\n' + body);
  chmodSync(OUT, 0o755);
  console.log('Built single-file executable:', OUT, '(needs `node` on $PATH)');
} finally {
  rmSync(BLOB, { force: true });
  if (existsSync(BLOB)) rmSync(BLOB, { force: true });
}

function distroNodeCheck() {
  if (!readFileSync(process.execPath).toString('latin1').includes('NODE_SEA_FUSE_cece90d558edb4ad')) {
    throw new Error('current node build has no SEA sentinel fuse');
  }
}
