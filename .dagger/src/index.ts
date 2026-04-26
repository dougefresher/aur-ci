import { argument, Container, dag, File, func, object } from "@dagger.io/dagger"

type NvcheckerEvent = {
  event?: string
  name?: string
  version?: string
}

type PackageEntry = {
  name: string
  nvcheckerName?: string
  enabled?: boolean
}

type CheckResult = {
  pkgname: string
  nvcheckerName: string
  repo: string
  currentPkgver: string
  latestVersion: string
  changed: boolean
  checkedAt: string
}

type ClonedRepo = {
  repoUrl: string
  repoDir: string
  container: Container
}

@object()
export class AurCi {
  /**
   * Load package configuration from packages.json and return a JSON array
   * suitable for GitHub matrix usage.
   */
  @func()
  async packages(
    @argument({ defaultPath: "/packages.json" })
    config: File,
  ): Promise<string> {
    const raw = await config.contents()
    const parsed = JSON.parse(raw) as unknown

    if (!Array.isArray(parsed)) {
      throw new Error("packages.json must contain a JSON array")
    }

    const normalized: Array<{ name: string; nvcheckerName?: string }> = []

    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        throw new Error("Each packages.json entry must be an object")
      }

      const entry = item as PackageEntry
      if (typeof entry.name !== "string" || entry.name.trim() === "") {
        throw new Error("Each packages.json entry must include a non-empty 'name'")
      }

      if (entry.enabled === false) {
        continue
      }

      if (entry.nvcheckerName !== undefined && typeof entry.nvcheckerName !== "string") {
        throw new Error(`nvcheckerName for '${entry.name}' must be a string`)
      }

      normalized.push({
        name: entry.name,
        ...(entry.nvcheckerName ? { nvcheckerName: entry.nvcheckerName } : {}),
      })
    }

    return JSON.stringify(normalized, null, 2)
  }

  /**
   * Check one AUR package for upstream version changes using nvchecker.
   */
  @func()
  async checkPackageChanged(
    pkgname: string,
    baseImage = "ghcr.io/carteramesh/docker/aur-builder:latest",
    aurBaseUrl = "ssh://aur@aur.archlinux.org",
    nvcheckerName?: string,
  ): Promise<string> {
    const check = await this.runCheck(pkgname, baseImage, aurBaseUrl, nvcheckerName)

    return JSON.stringify(
      {
        status: "ok",
        ...check,
      },
      null,
      2,
    )
  }

  /**
   * Verify that the package can run source verification with makepkg.
   */
  @func()
  async verifyPackage(
    pkgname: string,
    baseImage = "ghcr.io/carteramesh/docker/aur-builder:latest",
    aurBaseUrl = "ssh://aur@aur.archlinux.org",
  ): Promise<string> {
    const cloned = this.cloneAurRepo(pkgname, baseImage, aurBaseUrl)
    await this.runMakepkgVerify(cloned.container, cloned.repoDir)

    return JSON.stringify(
      {
        status: "ok",
        pkgname,
        repo: cloned.repoUrl,
        verify: {
          status: "passed",
          command: "source PKGBUILD && makepkg --verifysource",
        },
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    )
  }

  /**
   * Combined workflow: check upstream change, then verify with makepkg only
   * when a change is detected.
   */
  @func()
  async checkAndVerifyPackage(
    pkgname: string,
    baseImage = "ghcr.io/carteramesh/docker/aur-builder:latest",
    aurBaseUrl = "ssh://aur@aur.archlinux.org",
    nvcheckerName?: string,
  ): Promise<string> {
    const cloned = this.cloneAurRepo(pkgname, baseImage, aurBaseUrl)
    const pkgRef = nvcheckerName?.trim() || pkgname
    const check = await this.collectCheckResult(cloned, pkgname, pkgRef)

    let verify: { status: "passed" | "skipped"; reason?: string; command?: string }

    if (check.changed) {
      await this.runMakepkgVerify(cloned.container, cloned.repoDir)
      verify = {
        status: "passed",
        command: "source PKGBUILD && makepkg --verifysource",
      }
    } else {
      verify = {
        status: "skipped",
        reason: "up-to-date",
      }
    }

    return JSON.stringify(
      {
        status: "ok",
        ...check,
        verify,
        processedAt: new Date().toISOString(),
      },
      null,
      2,
    )
  }

  private runCheck(
    pkgname: string,
    baseImage: string,
    aurBaseUrl: string,
    nvcheckerName?: string,
  ): Promise<CheckResult> {
    const cloned = this.cloneAurRepo(pkgname, baseImage, aurBaseUrl)
    const pkgRef = nvcheckerName?.trim() || pkgname

    return this.collectCheckResult(cloned, pkgname, pkgRef)
  }

  private cloneAurRepo(pkgname: string, baseImage: string, aurBaseUrl: string): ClonedRepo {
    const normalizedAurBase = aurBaseUrl.replace(/\/+$/, "")
    const repoUrl = `${normalizedAurBase}/${pkgname}.git`
    const repoDir = "/home/aur_builder/repo"
    const container = dag
      .container()
      .from(baseImage)
      .withExec(["git", "clone", "--depth", "1", repoUrl, repoDir])
    return {
      repoUrl,
      repoDir,
      container,
    }
  }

  private async collectCheckResult(cloned: ClonedRepo, pkgname: string, pkgRef: string): Promise<CheckResult> {
    const currentPkgver = (
      await cloned.container
        .withWorkdir(cloned.repoDir)
        .withExec(["bash", "-lc", "source PKGBUILD; echo -n \"$pkgver\""])
        .stdout()
    ).trim()

    if (!currentPkgver) {
      throw new Error(`Could not read pkgver from PKGBUILD for ${pkgname}`)
    }

    const nvcheckerJsonLogs = await cloned.container
      .withWorkdir(cloned.repoDir)
      .withExec(["nvchecker", "-c", ".nvchecker.toml", "--logger=json"])
      .stdout()

    const latestVersion = this.extractLatestVersion(nvcheckerJsonLogs, pkgRef)

    if (!latestVersion) {
      throw new Error(`nvchecker returned no version for ${pkgRef}`)
    }

    return {
      pkgname,
      nvcheckerName: pkgRef,
      repo: cloned.repoUrl,
      currentPkgver,
      latestVersion,
      changed: currentPkgver !== latestVersion,
      checkedAt: new Date().toISOString(),
    }
  }

  private async runMakepkgVerify(container: Container, repoDir: string): Promise<void> {
    await container
      .withWorkdir(repoDir)
      .withExec(["bash", "-lc", "source PKGBUILD; makepkg --verifysource"])
      .sync()
  }

  private extractLatestVersion(logs: string, pkgRef: string): string | null {
    let latestVersion: string | null = null

    for (const rawLine of logs.split("\n")) {
      const line = rawLine.trim()
      if (!line) {
        continue
      }

      let event: NvcheckerEvent
      try {
        event = JSON.parse(line) as NvcheckerEvent
      } catch {
        continue
      }

      const isSupportedEvent = event.event === "updated" || event.event === "up-to-date"
      if (!isSupportedEvent || event.name !== pkgRef || !event.version) {
        continue
      }

      latestVersion = event.version
    }

    return latestVersion
  }
}
