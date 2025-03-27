"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitLabAdapter = exports.GitHubAdapter = void 0;
exports.createPlatformAdapter = createPlatformAdapter;
const rest_1 = require("@octokit/rest");
const utils_1 = require("./utils");
const node_fetch_1 = __importDefault(require("node-fetch"));
// GitHub Адаптер
/**
 * Адаптер для работы с GitHub API
 */
class GitHubAdapter {
    /**
     * Создает новый адаптер для GitHub
     * @param token GitHub токен доступа
     * @param repository Репозиторий в формате owner/repo
     */
    constructor(token, repository) {
        this.octokit = new rest_1.Octokit({ auth: token });
        [this.owner, this.repo] = repository.split('/');
        if (!this.owner || !this.repo) {
            throw new Error('Invalid repository format. Expected "owner/repo"');
        }
    }
    /**
     * Получить содержимое файла из GitHub
     */
    async getFileContent(path, ref) {
        const { data: fileContent } = await (0, utils_1.withRetry)(() => this.octokit.repos.getContent({
            owner: this.owner,
            repo: this.repo,
            path,
            ref,
        }));
        if (!('content' in fileContent)) {
            throw new Error('File content not found');
        }
        return Buffer.from(fileContent.content, 'base64').toString();
    }
    /**
     * Получить измененные файлы в PR
     */
    async getChangedFiles(prNumber) {
        const { data: files } = await (0, utils_1.withRetry)(() => this.octokit.pulls.listFiles({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
        }));
        const result = [];
        for (const file of files) {
            if (file.filename.match(/\.(ts|tsx|js|jsx)$/)) {
                try {
                    const content = await this.getFileContent(file.filename, `pull/${prNumber}/head`);
                    result.push({
                        path: file.filename,
                        content,
                        patch: file.patch
                    });
                }
                catch (error) {
                    console.error(`Error getting content for ${file.filename}:`, error);
                }
            }
        }
        return result;
    }
    /**
     * Создать ревью с комментариями
     */
    async createReview(prNumber, comments) {
        if (comments.length === 0) {
            console.log('No comments to create');
            return;
        }
        // Добавляем детальное логирование
        console.log('==== Creating review with comments ====');
        console.log(`Total comments: ${comments.length}`);
        try {
            console.log('Calling GitHub API to create review...');
            const { data: review } = await (0, utils_1.withRetry)(() => this.octokit.pulls.createReview({
                owner: this.owner,
                repo: this.repo,
                pull_number: prNumber,
                event: 'COMMENT',
                comments,
            }));
            console.log(`Created review: ${review.html_url}`);
        }
        catch (error) {
            const githubError = error;
            console.error('Error creating review:', githubError.status ? `Status: ${githubError.status}` : '', githubError.message || '');
            if (githubError.status === 422) {
                console.error('Failed to create review. Some comments might be outside of the diff.');
                console.log('Error:', JSON.stringify(githubError));
                // Попытаемся создать комментарии по одному, чтобы определить проблемные
                console.log('Trying to create comments one by one to identify problematic ones...');
                let successCount = 0;
                let failCount = 0;
                for (let i = 0; i < comments.length; i++) {
                    const comment = comments[i];
                    try {
                        // Получаем информацию о PR для создания review comment
                        const { data: pr } = await (0, utils_1.withRetry)(() => this.octokit.pulls.get({
                            owner: this.owner,
                            repo: this.repo,
                            pull_number: prNumber,
                        }));
                        await (0, utils_1.withRetry)(() => this.octokit.pulls.createReviewComment({
                            owner: this.owner,
                            repo: this.repo,
                            pull_number: prNumber,
                            body: comment.body,
                            commit_id: pr.head.sha,
                            path: comment.path,
                            line: comment.line,
                        }));
                        successCount++;
                    }
                    catch (commentError) {
                        failCount++;
                        console.error(`Failed to create comment ${i + 1} for ${comment.path}:${comment.line} -`, commentError.status || '', commentError.message || '');
                    }
                }
                console.log(`Individual comment creation results: ${successCount} succeeded, ${failCount} failed`);
            }
            else {
                throw error;
            }
        }
    }
    /**
     * Ответить на комментарий в PR
     */
    async replyToComment(prNumber, commentId, body) {
        // Получаем информацию о PR для создания review comment
        const { data: pr } = await (0, utils_1.withRetry)(() => this.octokit.pulls.get({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
        }));
        const comment = await this.getComment(commentId);
        await (0, utils_1.withRetry)(() => this.octokit.pulls.createReviewComment({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
            body,
            commit_id: pr.head.sha,
            path: comment.path,
            line: comment.line,
            in_reply_to: commentId,
        }));
    }
    /**
     * Получить информацию о комментарии
     */
    async getComment(commentId) {
        const { data: comment } = await (0, utils_1.withRetry)(() => this.octokit.pulls.getReviewComment({
            owner: this.owner,
            repo: this.repo,
            comment_id: commentId,
        }));
        if (!comment?.body || !comment.pull_request_url || !comment.line || !comment.path) {
            throw new Error('Required comment data is missing');
        }
        // Получаем номер PR
        const prId = Number(comment.pull_request_url.split('/').pop());
        if (!prId) {
            throw new Error('Could not extract PR number from URL');
        }
        return {
            id: comment.id,
            body: comment.body,
            path: comment.path,
            line: comment.line,
            prId,
            createdAt: new Date(comment.created_at),
        };
    }
    /**
     * Получить список комментариев в PR
     */
    async listComments(prNumber) {
        const { data: reviewComments } = await (0, utils_1.withRetry)(() => this.octokit.pulls.listReviewComments({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
            per_page: 100,
        }));
        return reviewComments.map(comment => ({
            id: comment.id,
            body: comment.body || '',
            path: comment.path || '',
            line: comment.line || 0,
            prId: prNumber,
            createdAt: new Date(comment.created_at),
        }));
    }
}
exports.GitHubAdapter = GitHubAdapter;
// GitLab Адаптер
/**
 * Адаптер для работы с GitLab API
 */
class GitLabAdapter {
    /**
     * Создает новый адаптер для GitLab
     * @param token GitLab токен доступа
     * @param projectId ID проекта в GitLab
     * @param apiUrl URL GitLab API (по умолчанию https://gitlab.com/api/v4)
     */
    constructor(token, projectId, apiUrl = 'https://gitlab.com/api/v4') {
        this.token = token;
        this.projectId = projectId;
        this.apiUrl = apiUrl;
    }
    /**
     * Создает запрос к GitLab API
     */
    async makeRequest(endpoint, method = 'GET', body) {
        return (0, utils_1.withRetry)(async () => {
            const response = await (0, node_fetch_1.default)(`${this.apiUrl}${endpoint}`, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`,
                },
                body: body ? JSON.stringify(body) : undefined,
            });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`GitLab API error: ${response.status} ${response.statusText}\n${errorText}`);
            }
            return response.json();
        });
    }
    /**
     * Получить содержимое файла из GitLab
     */
    async getFileContent(path, ref) {
        const encodedPath = encodeURIComponent(path);
        const encodedRef = encodeURIComponent(ref);
        const endpoint = `/projects/${this.projectId}/repository/files/${encodedPath}/raw?ref=${encodedRef}`;
        const response = await (0, utils_1.withRetry)(() => (0, node_fetch_1.default)(`${this.apiUrl}${endpoint}`, {
            headers: {
                'Authorization': `Bearer ${this.token}`,
            },
        }));
        if (!response.ok) {
            throw new Error(`Failed to fetch file content: ${response.status} ${response.statusText}`);
        }
        return response.text();
    }
    /**
     * Получить измененные файлы в MR
     */
    async getChangedFiles(mergeRequestIid) {
        const endpoint = `/projects/${this.projectId}/merge_requests/${mergeRequestIid}/changes`;
        const data = await this.makeRequest(endpoint);
        const result = [];
        for (const change of data.changes) {
            if (change.new_path.match(/\.(ts|tsx|js|jsx)$/)) {
                try {
                    const content = await this.getFileContent(change.new_path, `refs/merge-requests/${mergeRequestIid}/head`);
                    result.push({
                        path: change.new_path,
                        content,
                        patch: change.diff
                    });
                }
                catch (error) {
                    console.error(`Error getting content for ${change.new_path}:`, error);
                }
            }
        }
        return result;
    }
    /**
     * Создать ревью с комментариями
     */
    async createReview(mergeRequestIid, comments) {
        if (comments.length === 0) {
            console.log('No comments to create');
            return;
        }
        // В GitLab нужно создавать комментарии по одному
        for (const comment of comments) {
            const endpoint = `/projects/${this.projectId}/merge_requests/${mergeRequestIid}/discussions`;
            await this.makeRequest(endpoint, 'POST', {
                body: comment.body,
                position: {
                    position_type: 'text',
                    new_path: comment.path,
                    new_line: comment.line,
                    base_sha: null,
                    start_sha: null,
                    head_sha: null
                }
            });
        }
        console.log(`Created ${comments.length} comments for MR !${mergeRequestIid}`);
    }
    /**
     * Ответить на комментарий в MR
     */
    async replyToComment(mergeRequestIid, discussionId, body) {
        const endpoint = `/projects/${this.projectId}/merge_requests/${mergeRequestIid}/discussions/${discussionId}/notes`;
        await this.makeRequest(endpoint, 'POST', { body });
    }
    /**
     * Получить информацию о комментарии
     */
    async getComment(noteId) {
        // В GitLab нет прямого пути к получению заметки по ID,
        // поэтому нужно получить информацию о MR и затем найти заметку
        const { mrIid, discussionId } = await this.findNoteContext(noteId);
        // Получаем дискуссию
        const endpoint = `/projects/${this.projectId}/merge_requests/${mrIid}/discussions/${discussionId}`;
        const discussion = await this.makeRequest(endpoint);
        // Находим нужную заметку
        const note = discussion.notes.find((n) => n.id.toString() === noteId.toString());
        if (!note) {
            throw new Error(`Note ${noteId} not found in discussion ${discussionId}`);
        }
        return {
            id: note.id,
            body: note.body,
            path: note.position?.new_path || '',
            line: note.position?.new_line || 0,
            prId: mrIid,
            createdAt: new Date(note.created_at),
        };
    }
    /**
     * Найти контекст заметки (MR IID и ID дискуссии)
     */
    async findNoteContext(noteId) {
        // GitLab API не имеет прямого метода для получения контекста заметки
        // Это упрощенная логика, в реальном приложении понадобится более сложный подход
        // или сохранение этих данных на стороне клиента
        // В рамках данного примера предполагаем, что noteId это составной ключ в формате
        // "merge_request_iid:discussion_id:note_id"
        const parts = noteId.toString().split(':');
        if (parts.length !== 3) {
            throw new Error(`Invalid note ID format: ${noteId}. Expected "merge_request_iid:discussion_id:note_id"`);
        }
        return {
            mrIid: parts[0],
            discussionId: parts[1]
        };
    }
    /**
     * Получить список комментариев в MR
     */
    async listComments(mergeRequestIid) {
        const endpoint = `/projects/${this.projectId}/merge_requests/${mergeRequestIid}/discussions`;
        const discussions = await this.makeRequest(endpoint);
        const comments = [];
        for (const discussion of discussions) {
            for (const note of discussion.notes) {
                if (note.position) {
                    comments.push({
                        // Создаем составной идентификатор
                        id: `${mergeRequestIid}:${discussion.id}:${note.id}`,
                        body: note.body,
                        path: note.position.new_path,
                        line: note.position.new_line,
                        prId: mergeRequestIid,
                        createdAt: new Date(note.created_at),
                    });
                }
            }
        }
        return comments;
    }
}
exports.GitLabAdapter = GitLabAdapter;
/**
 * Создать соответствующий адаптер платформы контроля версий
 */
function createPlatformAdapter(platform, options) {
    switch (platform) {
        case 'github':
            return new GitHubAdapter(options.token, options.repository);
        case 'gitlab':
            return new GitLabAdapter(options.token, options.projectId, options.apiUrl);
        default:
            throw new Error(`Unsupported platform: ${platform}`);
    }
}
