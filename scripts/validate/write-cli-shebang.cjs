const fs = require('fs');
const path = require('path');

const distDir = path.join(process.cwd(), 'dist');
const nestedCliPath = path.join(distDir, 'cli', 'index.js');
const rootCliPath = path.join(distDir, 'cli.js');

if (!fs.existsSync(nestedCliPath)) {
  process.exit(0);
}

const shebang = '#!/usr/bin/env node\n';
const nestedSource = fs.readFileSync(nestedCliPath, 'utf8');
if (!nestedSource.startsWith(shebang)) {
  fs.writeFileSync(nestedCliPath, shebang + nestedSource, 'utf8');
}
fs.chmodSync(nestedCliPath, 0o755);

const wrapper = `${shebang}import './cli/index.js';\n`;
fs.writeFileSync(rootCliPath, wrapper, 'utf8');
fs.chmodSync(rootCliPath, 0o755);
