// Run by CI inside the API image (Dockerfile.api, #730), as the image's own
// user. It proves the runtime is unprivileged and cannot change its own code,
// and that the native modules and the files the code reads at runtime load.
// The pre-deploy migration is proven by the step after this one.
import { access, constants } from 'node:fs/promises';
import { createRequire } from 'node:module';

// This file is mounted outside the app, so the app's packages are resolved from it.
const fromApp = createRequire('/app/package.json');

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

if (process.getuid() === 0) fail('the image runs as root');

for (const path of ['dist', 'dist/mcp/httpServer.js', 'node_modules', 'db/migrations', 'widgets', 'assets/fonts']) {
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

const { FONT_FILES, fontBytes } = await import('/app/dist/render/fonts.js');
for (const name of Object.keys(FONT_FILES)) {
  if (fontBytes(name).length === 0) fail(`the font ${name} is empty`);
}

console.log(`OK: uid ${process.getuid()}, code read-only, sharp, bcrypt and ${Object.keys(FONT_FILES).length} fonts load`);
