import { Octokit } from '@octokit/rest';
import { PlatformAdapter, PullRequestInfo, ReviewComment } from './types';
import { withRetry } from '../utils/retry';

export class GitHubAdapter implements PlatformAdapter {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private eventName: string;
  private prNumber?: number;

  constructor({ token, repository, eventName, prNumber }: {
    token: string;
    repository: string;
    eventName: string;
    prNumber?: string;
  }) {
    this.octokit = new Octokit({ auth: token });
    const [owner, repo] = repository.split('/');
    this.owner = owner;
    this.repo = repo;
    this.eventName = eventName;
    if (eventName === 'pull_request' && prNumber) {
      this.prNumber = Number(prNumber);
    }
  }

  async getChangedFiles(prInfo: PullRequestInfo) {
    const { data: files } = await withRetry(() => this.octokit.pulls.listFiles({
      owner: prInfo.owner,
      repo: prInfo.repo,
      pull_number: prInfo.pull_number,
    }));
    return files.map(f => ({ filename: f.filename, patch: f.patch }));
  }

  async getPRDiff(prInfo: PullRequestInfo) {
    const { data: pr } = await withRetry(() => this.octokit.pulls.get({
      owner: prInfo.owner,
      repo: prInfo.repo,
      pull_number: prInfo.pull_number,
    }));
    return pr;
  }

  async createReview(prInfo: PullRequestInfo, comments: ReviewComment[]) {
    await withRetry(() => this.octokit.pulls.createReview({
      owner: prInfo.owner,
      repo: prInfo.repo,
      pull_number: prInfo.pull_number,
      event: 'COMMENT',
      comments,
    }));
  }

  async getFileContent(prInfo: PullRequestInfo, filePath: string): Promise<string> {
    const { data: fileContent } = await withRetry(() => this.octokit.repos.getContent({
      owner: prInfo.owner,
      repo: prInfo.repo,
      path: filePath,
      ref: `pull/${prInfo.pull_number}/head`,
    }));
    if (!('content' in fileContent)) {
      throw new Error('File content not found');
    }
    return Buffer.from(fileContent.content, 'base64').toString();
  }

  async getEventInfo(): Promise<PullRequestInfo | null> {
    if (this.eventName === 'pull_request' && this.prNumber) {
      return {
        owner: this.owner,
        repo: this.repo,
        pull_number: this.prNumber,
      };
    }
    return null;
  }
} 