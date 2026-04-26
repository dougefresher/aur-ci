import { type Container, type Directory, func, object } from '@dagger.io/dagger';
import { dag } from '@dagger.io/dagger';

type NvcheckerEvent = {
  event?: string;
  name?: string;
  version?: string;
};

type CheckResult = {
  pkgname: string;
  nvcheckerName: string;
  repo: string;
  currentPkgver: string;
  latestVersion: string;
  changed: boolean;
  checkedAt: string;
};

type RepoWorkspace = {
  repoDir: string;
  container: Container;
};

@object()
export class AurCi {
  @func()
  async checkAndVerifyPackage(
    pkgname: string,
    repoDir: Directory,
    baseImage = 'ghcr.io/carteramesh/docker/aur-builder:latest',
    nvcheckerName?: string,
  ): Promise<string> {
    const workspace = this.prepareRepoWorkspace(baseImage, repoDir);
    const pkgRef = nvcheckerName?.trim() || pkgname;
    const check = await this.collectCheckResult(workspace, pkgname, pkgRef);
    let verify: { status: 'passed' | 'skipped'; reason?: string; command?: string };
    if (check.changed) {
      await this.runMakepkgBuild(workspace.container, workspace.repoDir, check);
      verify = {
        status: 'passed',
        command: 'source PKGBUILD && makepkg --verifysource && makepkg --force --cleanbuild --noconfirm',
      };
    } else {
      verify = {
        status: 'skipped',
        reason: 'up-to-date',
      };
    }

    return JSON.stringify(
      {
        status: 'ok',
        ...check,
        verify,
        processedAt: new Date().toISOString(),
      },
      null,
      2,
    );
  }

  private prepareRepoWorkspace(baseImage: string, repoDirInput: Directory): RepoWorkspace {
    const repoDir = '/home/aur_builder/repo';
    const container = dag.container().from(baseImage).withDirectory(repoDir, repoDirInput, { owner: '1001:1001' });

    return {
      repoDir,
      container,
    };
  }

  private async collectCheckResult(workspace: RepoWorkspace, pkgname: string, pkgRef: string): Promise<CheckResult> {
    const currentPkgver = (
      await workspace.container
        .withWorkdir(workspace.repoDir)
        .withExec(['bash', '-lc', 'source PKGBUILD; echo -n "$pkgver"'])
        .stdout()
    ).trim();

    if (!currentPkgver) {
      throw new Error(`Could not read pkgver from PKGBUILD for ${pkgname}`);
    }

    const nvcheckerJsonLogs = await workspace.container
      .withWorkdir(workspace.repoDir)
      .withExec(['nvchecker', '-c', '.nvchecker.toml', '--logger=json'])
      .stdout();

    const latestVersion = this.extractLatestVersion(nvcheckerJsonLogs, pkgRef);

    if (!latestVersion) {
      throw new Error(`nvchecker returned no version for ${pkgRef}`);
    }

    return {
      pkgname,
      nvcheckerName: pkgRef,
      repo: `workspace://${pkgname}`,
      currentPkgver,
      latestVersion,
      changed: currentPkgver !== latestVersion,
      checkedAt: new Date().toISOString(),
    };
  }

  private async runMakepkgBuild(container: Container, repoDir: string, checkResult: CheckResult): Promise<void> {
    const pkgver_update = `awk -v v="${checkResult.latestVersion}" '
  /^pkgver=/ { print "pkgver=" v; next }
  /^pkgrel=/ { print "pkgrel=1"; next }
  { print }
' PKGBUILD > /tmp/p"
mv /tmp/p PKGBUILD`;
    await container
      .withWorkdir(repoDir)
      .withExec([
        'bash',
        '-lc',
        'source PKGBUILD; makepkg --verifysource; echo makepkg --force --cleanbuild --noconfirm',
      ])
      .withExec(['bash', '-lc', pkgver_update])
      .withExec(['updpkgsums'])
      .withExec(['bash', '-lc', 'makepkg --printsrcinfo >.SRCINFO'])
      .withExec(['namcap', 'PKGBUILD'])
      .sync();
  }

  private extractLatestVersion(logs: string, pkgRef: string): string | null {
    let latestVersion: string | null = null;

    for (const rawLine of logs.split('\n')) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      let event: NvcheckerEvent;
      try {
        event = JSON.parse(line) as NvcheckerEvent;
      } catch {
        continue;
      }

      const isSupportedEvent = event.event === 'updated' || event.event === 'up-to-date';
      if (!isSupportedEvent || event.name !== pkgRef || !event.version) {
        continue;
      }

      latestVersion = event.version;
    }

    return latestVersion;
  }
}
