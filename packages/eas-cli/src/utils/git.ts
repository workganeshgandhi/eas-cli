import spawnAsync from '@expo/spawn-async';

interface GitStatusOptions {
  showUntracked?: boolean;
}

async function gitStatusAsync({ showUntracked }: GitStatusOptions = {}): Promise<string> {
  return (await spawnAsync('git', ['status', '-s', showUntracked ? '-uall' : '-uno'])).stdout;
}

async function gitDiffAsync(): Promise<void> {
  await spawnAsync('git', ['--no-pager', 'diff'], { stdio: ['ignore', 'inherit', 'inherit'] });
}

async function gitAddAsync(file: string, options?: { intentToAdd?: boolean }): Promise<void> {
  if (options?.intentToAdd) {
    await spawnAsync('git', ['add', '--intent-to-add', file]);
  } else {
    await spawnAsync('git', ['add', file]);
  }
}

async function gitRootDirectoryAsync(): Promise<string> {
  return (await spawnAsync('git', ['rev-parse', '--show-toplevel'])).stdout.trim();
}

async function doesGitRepoExistAsync(): Promise<boolean> {
  try {
    await spawnAsync('git', ['rev-parse', '--git-dir']);
    return true;
  } catch (err) {
    return false;
  }
}

async function isGitInstalledAsync(): Promise<boolean> {
  try {
    await spawnAsync('git', ['--help']);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  return true;
}

async function getBranchNameAsync(): Promise<string | undefined> {
  try {
    return (await spawnAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout;
  } catch (e) {}
}

export {
  gitStatusAsync,
  gitDiffAsync,
  gitAddAsync,
  doesGitRepoExistAsync,
  gitRootDirectoryAsync,
  isGitInstalledAsync,
  getBranchNameAsync,
};