/**
 * Gitea is where a plan's work survives teardown (decision B7): one repo per
 * project, a `plan/<id>` branch per plan, and an operator-merged pull request.
 *
 * NOTE: `HttpGiteaClient` has not been exercised against a live Gitea. There is
 * no Gitea instance until `infra/` exists (baseline section 12 step 1 covers
 * scaffolding, not provisioning), so it is verified only against mocked HTTP.
 * Treat the request shapes as unproven until the first real deployment.
 */

export interface GiteaClient {
  /** Create-if-absent, initialised with a commit on `main` so a branch point exists. */
  ensureRepo(name: string): Promise<{ clone_url: string }>;
  /** Idempotent: an existing branch of the same name is a success. */
  createBranch(repo: string, branch: string, from: 'main'): Promise<void>;
  /** Returns the token plus an opaque ref used to revoke it at teardown. */
  createBotToken(repo: string, planId: string): Promise<{ token: string; ref: string }>;
  revokeBotToken(ref: string): Promise<void>;
  fileExists(repo: string, branch: string, path: string): Promise<boolean>;
  headSha(repo: string, branch: string): Promise<string>;
  /** Find-or-create. Null when `head` has no commits ahead of `base`. */
  openPullRequest(
    repo: string,
    head: string,
    base: 'main',
    title: string,
  ): Promise<{ url: string } | null>;
}

export interface GiteaConfig {
  baseUrl: string;
  /** A Gitea organisation, administered by the account `adminToken` belongs to. */
  owner: string;
  adminToken: string;
}

export class GiteaError extends Error {
  readonly code = 'gitea_error';

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GiteaError';
  }
}

export class HttpGiteaClient implements GiteaClient {
  constructor(private readonly config: GiteaConfig) {}

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/$/, '')}/api/v1${path}`;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const response = await fetch(this.url(path), {
      method,
      headers: {
        authorization: `token ${this.config.adminToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: response.status, json };
  }

  private async expectOk(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const { status, json } = await this.request(method, path, body);
    if (status < 200 || status >= 300) {
      throw new GiteaError(`${method} ${path} returned ${status}`, status);
    }
    return json;
  }

  async ensureRepo(name: string): Promise<{ clone_url: string }> {
    const existing = await this.request('GET', `/repos/${this.config.owner}/${name}`);
    if (existing.status === 200) {
      return { clone_url: (existing.json as { clone_url: string }).clone_url };
    }
    if (existing.status !== 404) {
      throw new GiteaError(`lookup of ${name} returned ${existing.status}`, existing.status);
    }

    // Named-owner create, not `POST /user/repos`: that one places the repo under
    // whoever holds the admin token, while every other call here addresses
    // `/repos/${owner}/...`. When those differ, a project repo is created on every
    // propose and found by none of them. `owner` is therefore a Gitea organisation
    // the token's user administers, not the token's user.
    const created = (await this.expectOk('POST', `/orgs/${this.config.owner}/repos`, {
      name,
      private: true,
      // Without an initial commit there is no branch point for plan/<id>.
      auto_init: true,
      default_branch: 'main',
    })) as { clone_url: string };
    return { clone_url: created.clone_url };
  }

  async createBranch(repo: string, branch: string, from: 'main'): Promise<void> {
    const { status } = await this.request(
      'POST',
      `/repos/${this.config.owner}/${repo}/branches`,
      { new_branch_name: branch, old_branch_name: from },
    );
    // 409 is "branch already exists", which is the state we wanted.
    if (status === 409 || (status >= 200 && status < 300)) return;
    throw new GiteaError(`creating branch ${branch} returned ${status}`, status);
  }

  /**
   * Gitea access tokens are user-scoped, not repo-scoped, so isolation comes
   * from a per-plan bot user holding write access to exactly one repo, with
   * protected-branch rules on `main` (baseline section 7). The ref is that
   * username: revoking means deleting the user.
   */
  async createBotToken(repo: string, planId: string): Promise<{ token: string; ref: string }> {
    const username = `mycelium-bot-${planId.replace(/-/g, '').slice(0, 20)}`;
    const password = randomPassword();

    await this.expectOk('POST', '/admin/users', {
      username,
      email: `${username}@mycelium.local`,
      password,
      must_change_password: false,
    });

    await this.expectOk(
      'PUT',
      `/repos/${this.config.owner}/${repo}/collaborators/${username}`,
      { permission: 'write' },
    );

    const created = (await this.expectOk('POST', `/users/${username}/tokens`, {
      name: `plan-${planId}`,
      scopes: ['write:repository'],
    })) as { sha1: string };

    return { token: created.sha1, ref: username };
  }

  async revokeBotToken(ref: string): Promise<void> {
    const { status } = await this.request('DELETE', `/admin/users/${ref}`);
    if (status === 404 || (status >= 200 && status < 300)) return;
    throw new GiteaError(`revoking ${ref} returned ${status}`, status);
  }

  async fileExists(repo: string, branch: string, path: string): Promise<boolean> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const { status } = await this.request(
      'GET',
      `/repos/${this.config.owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`,
    );
    if (status === 200) return true;
    if (status === 404) return false;
    throw new GiteaError(`contents lookup returned ${status}`, status);
  }

  async headSha(repo: string, branch: string): Promise<string> {
    const json = (await this.expectOk(
      'GET',
      `/repos/${this.config.owner}/${repo}/branches/${encodeURIComponent(branch)}`,
    )) as { commit: { id: string } };
    return json.commit.id;
  }

  async openPullRequest(
    repo: string,
    head: string,
    base: 'main',
    title: string,
  ): Promise<{ url: string } | null> {
    const [headSha, baseSha] = await Promise.all([
      this.headSha(repo, head),
      this.headSha(repo, base),
    ]);
    // Nothing was pushed, so there is nothing to review.
    if (headSha === baseSha) return null;

    const owner = this.config.owner;
    const existing = (await this.expectOk(
      'GET',
      `/repos/${owner}/${repo}/pulls?state=open&limit=50`,
    )) as Array<{ head: { ref: string }; base: { ref: string }; html_url: string }>;

    const match = existing.find((pr) => pr.head.ref === head && pr.base.ref === base);
    if (match) return { url: match.html_url };

    const created = (await this.expectOk('POST', `/repos/${owner}/${repo}/pulls`, {
      head,
      base,
      title,
    })) as { html_url: string };
    return { url: created.html_url };
  }
}

function randomPassword(): string {
  // Only ever used to satisfy Gitea's user-creation requirement; the bot
  // authenticates with its token and the user is deleted at teardown.
  return `Mz${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}!`;
}
