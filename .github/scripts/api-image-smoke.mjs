// Run by CI inside the API image (Dockerfile.api, #730), as the image's own
// user. It proves the runtime is unprivileged and cannot change its own code,
// and that the native modules and the files the code reads at runtime load.
// The pre-deploy migration is proven by the step after this one.
import { lstatSync, readdirSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { createRequire } from 'node:module';

// This file is mounted outside the app, so the app's packages are resolved from it.
const fromApp = createRequire('/app/package.json');

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

if (process.getuid() === 0) fail('the image runs as root');

// Every directory and file under /app, the app's own directory included: write
// access on a directory lets its entries be renamed or replaced whoever owns
// them. The paths the code reads must be there first.
for (const path of ['package.json', 'dist/mcp/httpServer.js', 'dist/cli/runMaintenance.js', 'db/migrations', 'widgets/shared', 'assets/fonts']) {
  await access(path, constants.R_OK);
}
const everything = ['.', ...readdirSync('.', { recursive: true })];
for (const path of everything) {
  // Owned is as good as writable: an owner can make its file writable again.
  if (lstatSync(path).uid === process.getuid()) fail(`${path} is owned by the runtime user`);
  try {
    await access(path, constants.W_OK);
    fail(`${path} is writable by the runtime user`);
  } catch (error) {
    if (error.code !== 'EACCES') throw error;
  }
}

const sharp = (await import(fromApp.resolve('sharp'))).default;
const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
if (png.length === 0) fail('sharp made an empty image');

const bcrypt = (await import(fromApp.resolve('bcrypt'))).default;
if (!(await bcrypt.compare('letter', await bcrypt.hash('letter', 4)))) fail('bcrypt did not verify its own hash');

// The API's and the cron's entry points, with every module they import: a
// package or file missing from the image fails here, not on the first deploy.
// Each starts only when run directly: importing it loads its configuration,
// makes its pool (which connects on its first query) and the API's starts a rate-limit timer, so
// the check ends with an explicit exit.
await import('/app/dist/mcp/httpServer.js');
await import('/app/dist/cli/runMaintenance.js');

const { FONT_FILES, fontBytes } = await import('/app/dist/render/fonts.js');
for (const name of Object.keys(FONT_FILES)) {
  if (fontBytes(name).length === 0) fail(`the font ${name} is empty`);
}

console.log(`OK: uid ${process.getuid()}, code read-only, the API and cron entry points, sharp, bcrypt and ${Object.keys(FONT_FILES).length} fonts load`);
// An imported module may hold a pool or a timer open.
process.exit(0);
