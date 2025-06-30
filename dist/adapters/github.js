"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubAdapter = void 0;
const rest_1 = require("@octokit/rest");
const retry_1 = require("../utils/retry");
class GitHubAdapter {
    constructor({ token, repository, eventName, prNumber }) {
        this.octokit = new rest_1.Octokit({ auth: token });
        const [owner, repo] = repository.split('/');
        this.owner = owner;
        this.repo = repo;
        this.eventName = eventName;
        if (eventName === 'pull_request' && prNumber) {
            this.prNumber = Number(prNumber);
        }
    }
    async getChangedFiles(prInfo) {
        const { data: files } = await (0, retry_1.withRetry)(() => this.octokit.pulls.listFiles({
            owner: prInfo.owner,
            repo: prInfo.repo,
            pull_number: prInfo.pull_number,
        }));
        return files.map(f => ({ filename: f.filename, patch: f.patch }));
    }
    async getPRDiff(prInfo) {
        const { data: pr } = await (0, retry_1.withRetry)(() => this.octokit.pulls.get({
            owner: prInfo.owner,
            repo: prInfo.repo,
            pull_number: prInfo.pull_number,
        }));
        return pr;
    }
    async createReview(prInfo, comments) {
        await (0, retry_1.withRetry)(() => this.octokit.pulls.createReview({
            owner: prInfo.owner,
            repo: prInfo.repo,
            pull_number: prInfo.pull_number,
            event: 'COMMENT',
            comments,
        }));
    }
    async getFileContent(prInfo, filePath) {
        const { data: fileContent } = await (0, retry_1.withRetry)(() => this.octokit.repos.getContent({
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
    async getEventInfo() {
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
exports.GitHubAdapter = GitHubAdapter;
