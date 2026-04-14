import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface ClonedFixture {
  fixtureRoot: string;
  projectPath: string;
  memorizeRoot: string;
  expectationsPath: string;
  cleanup: () => Promise<void>;
}

async function copyDir(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      await copyDir(sourcePath, destinationPath);
      continue;
    }
    await fs.copyFile(sourcePath, destinationPath);
  }
}

export async function cloneFixtureToTmp(
  fixtureName: string,
): Promise<ClonedFixture> {
  const fixtureRoot = path.resolve(
    'tests',
    'fixtures',
    'existing-projects',
    fixtureName,
  );
  const sourceProjectPath = path.join(fixtureRoot, 'project');
  const expectationsPath = path.join(fixtureRoot, 'EXPECTATIONS.json');
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memorize-fixture-'));
  const projectPath = path.join(tempRoot, 'project');
  const memorizeRoot = path.join(tempRoot, '.memorize-home');

  await copyDir(sourceProjectPath, projectPath);
  await fs.mkdir(memorizeRoot, { recursive: true });

  return {
    fixtureRoot,
    projectPath,
    memorizeRoot,
    expectationsPath,
    cleanup: async () => {
      await fs.rm(tempRoot, { recursive: true, force: true });
    },
  };
}
