import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const packResult = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  encoding: 'utf8',
});

if (packResult.status !== 0) {
  process.stdout.write(
    JSON.stringify(
      {
        status: 'fail',
        reason: 'npm pack --dry-run failed',
        stdout: packResult.stdout,
        stderr: packResult.stderr,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
  files?: string[];
  bin?: Record<string, string>;
};
const packInfo = JSON.parse(packResult.stdout) as Array<{
  files: Array<{ path: string }>;
}>;

const includedFiles = packInfo[0]?.files.map((file) => file.path) ?? [];
const forbiddenMatches = includedFiles.filter(
  (entry) =>
    entry.startsWith('dist/tests/') ||
    entry.startsWith('dist/scripts/') ||
    entry.startsWith('tests/') ||
    entry.startsWith('scripts/') ||
    entry.startsWith('docs/'),
);

const declaredBinPath = packageJson.bin?.memorize;
const binPathValid = declaredBinPath ? includedFiles.includes(declaredBinPath) : false;

const report = {
  status:
    forbiddenMatches.length === 0 &&
    binPathValid &&
    (packageJson.files ?? []).includes('dist')
      ? 'pass'
      : 'fail',
  includedFiles,
  forbiddenMatches,
  binPathValid,
};

console.log(JSON.stringify(report, null, 2));
