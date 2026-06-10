import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/** @remotion/* packages pre-installed in every generated video project. */
export const REMOTION_EXTENSION_PACKAGES = [
  '@remotion/animation-utils',
  '@remotion/captions',
  '@remotion/fonts',
  '@remotion/gif',
  '@remotion/google-fonts',
  '@remotion/layout-utils',
  '@remotion/light-leaks',
  '@remotion/lottie',
  '@remotion/media',
  '@remotion/media-utils',
  '@remotion/motion-blur',
  '@remotion/noise',
  '@remotion/paths',
  '@remotion/preload',
  '@remotion/sfx',
  '@remotion/shapes',
  '@remotion/tailwind-v4',
  '@remotion/transitions',
  '@remotion/zod-types',
] as const;

export const AVAILABLE_PACKAGES = ['remotion', 'react', 'react-dom', ...REMOTION_EXTENSION_PACKAGES];

function readInstalledVersion(packageName: string): string {
  const pkg = require(`${packageName}/package.json`) as { version: string };
  return pkg.version;
}

export function getRemotionVersion(): string {
  return readInstalledVersion('remotion');
}

function buildProjectDependencies(): Record<string, string> {
  const remotionVersion = getRemotionVersion();
  const reactVersion = `^${readInstalledVersion('react')}`;

  const dependencies: Record<string, string> = {
    remotion: remotionVersion,
    react: reactVersion,
    'react-dom': reactVersion,
  };

  for (const pkg of REMOTION_EXTENSION_PACKAGES) {
    dependencies[pkg] = remotionVersion;
  }

  return dependencies;
}

function dependenciesChanged(
  existing: Record<string, string> | undefined,
  desired: Record<string, string>,
): boolean {
  if (!existing) return true;
  for (const [name, version] of Object.entries(desired)) {
    if (existing[name] !== version) return true;
  }
  for (const name of Object.keys(existing)) {
    if (!(name in desired)) return true;
  }
  return false;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureProjectDeps(
  outDir: string,
  onStatus?: (message: string) => void,
): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });

  const packageJsonPath = path.join(outDir, 'package.json');
  const nodeModulesPath = path.join(outDir, 'node_modules', 'remotion');
  const desiredDependencies = buildProjectDependencies();

  let existingPackageJson: { dependencies?: Record<string, string> } | null = null;
  try {
    existingPackageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
  } catch {
    // No package.json yet.
  }

  const packageJson = {
    name: 'remotion-video-project',
    private: true,
    type: 'module',
    dependencies: desiredDependencies,
  };

  const needsWrite = dependenciesChanged(existingPackageJson?.dependencies, desiredDependencies);
  if (needsWrite) {
    await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf-8');
  }

  const needsInstall = needsWrite || !(await pathExists(nodeModulesPath));
  if (!needsInstall) return;

  onStatus?.('Installing Remotion dependencies (first run may take a minute)…');
  await execFileAsync('npm', ['install', '--no-fund', '--no-audit'], {
    cwd: outDir,
    env: process.env,
  });
}
