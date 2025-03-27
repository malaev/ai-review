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
    async getChangedFiles(prNumber, sinceCommit) {
        console.log(`Getting changed files for PR #${prNumber}${sinceCommit ? ` since commit ${sinceCommit}` : ''}`);
        let changedFiles = [];
        // Первым делом получаем список всех измененных файлов в PR
        const { data: files } = await (0, utils_1.withRetry)(() => this.octokit.pulls.listFiles({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
            per_page: 100, // Увеличиваем количество файлов на страницу
        }));
        console.log(`Retrieved ${files.length} total changed files from GitHub API for PR #${prNumber}`);
        // Если указан коммит для фильтрации, нам нужно получить только файлы, измененные после этого коммита
        if (sinceCommit) {
            try {
                // Получаем текущий HEAD коммит PR
                const headCommit = await this.getCurrentCommit(prNumber);
                if (headCommit === sinceCommit) {
                    console.log('Current HEAD commit is the same as last analyzed commit, no new changes');
                    return [];
                }
                // Получаем список коммитов между sinceCommit и HEAD
                const { data: commits } = await (0, utils_1.withRetry)(() => this.octokit.repos.compareCommits({
                    owner: this.owner,
                    repo: this.repo,
                    base: sinceCommit,
                    head: headCommit,
                }));
                console.log(`Found ${commits.commits.length} new commits since ${sinceCommit}`);
                // Создаем множество файлов, которые были изменены в новых коммитах
                const changedFilePaths = new Set();
                const fileToCommits = new Map();
                for (const commit of commits.commits) {
                    // Получаем список измененных файлов в коммите
                    try {
                        const { data: commitData } = await (0, utils_1.withRetry)(() => this.octokit.repos.getCommit({
                            owner: this.owner,
                            repo: this.repo,
                            ref: commit.sha,
                        }));
                        for (const file of commitData.files || []) {
                            changedFilePaths.add(file.filename);
                            // Привязываем коммит к файлу
                            if (!fileToCommits.has(file.filename)) {
                                fileToCommits.set(file.filename, []);
                            }
                            fileToCommits.get(file.filename).push(commit.sha.substring(0, 7));
                        }
                    }
                    catch (e) {
                        console.error(`Error getting commit details for ${commit.sha}:`, e);
                    }
                }
                console.log(`Found ${changedFilePaths.size} unique files changed since ${sinceCommit}`);
                // Фильтруем список файлов PR, оставляя только те, которые были изменены после lastAnalyzedCommit
                changedFiles = files.filter(file => changedFilePaths.has(file.filename));
                // Добавляем информацию о коммитах к каждому файлу
                for (const file of changedFiles) {
                    file.commits = fileToCommits.get(file.filename) || [];
                }
                console.log(`Filtered to ${changedFiles.length} files that were modified since ${sinceCommit}`);
            }
            catch (e) {
                console.error(`Error filtering files by commit changes:`, e);
                // Если произошла ошибка, просто используем все файлы из PR
                changedFiles = files;
            }
        }
        else {
            // Если коммит для фильтрации не указан, используем все файлы из PR
            changedFiles = files;
        }
        const result = [];
        // Считаем статистику для лучшей диагностики
        const stats = {
            total: changedFiles.length,
            ts: 0,
            js: 0,
            other: 0,
            withPatch: 0,
            withoutPatch: 0
        };
        for (const file of changedFiles) {
            // Обновляем статистику
            if (file.filename.match(/\.(ts|tsx)$/)) {
                stats.ts++;
            }
            else if (file.filename.match(/\.(js|jsx)$/)) {
                stats.js++;
            }
            else {
                stats.other++;
            }
            if (file.patch) {
                stats.withPatch++;
            }
            else {
                stats.withoutPatch++;
            }
            // Обрабатываем только TypeScript/JavaScript файлы
            if (file.filename.match(/\.(ts|tsx|js|jsx)$/)) {
                try {
                    console.log(`Processing file: ${file.filename}`);
                    console.log(`- Status: ${file.status}, Changes: +${file.additions}/-${file.deletions}, Has patch: ${Boolean(file.patch)}`);
                    if (file.commits) {
                        console.log(`- Related commits: ${file.commits.join(', ')}`);
                    }
                    if (file.status === 'removed') {
                        console.log(`- Skipping removed file: ${file.filename}`);
                        continue;
                    }
                    // Если файл не имеет патча, дополнительно логируем причину
                    if (!file.patch) {
                        console.log(`- Warning: File ${file.filename} does not have a patch.`);
                        console.log(`  This could be because:`);
                        console.log(`  1. The file is too large (GitHub truncates patches)`);
                        console.log(`  2. The file is binary`);
                        console.log(`  3. File was renamed without changes`);
                        // Если файл большой, выведем дополнительную информацию
                        if (file.changes > 500) {
                            console.log(`  File has ${file.changes} changes which might exceed GitHub's patch limit`);
                        }
                    }
                    const content = await this.getFileContent(file.filename, `pull/${prNumber}/head`);
                    result.push({
                        path: file.filename,
                        content,
                        patch: file.patch,
                        commits: file.commits
                    });
                }
                catch (error) {
                    console.error(`Error getting content for ${file.filename}:`, error);
                    // Пытаемся все равно добавить файл, если есть патч
                    if (file.patch) {
                        result.push({
                            path: file.filename,
                            content: '', // Пустое содержимое
                            patch: file.patch,
                            commits: file.commits
                        });
                    }
                }
            }
            else {
                console.log(`Skipping non-TypeScript/JavaScript file: ${file.filename}`);
            }
        }
        // Выводим итоговую статистику
        console.log(`Files statistics:`);
        console.log(`- Total: ${stats.total} files`);
        console.log(`- TypeScript: ${stats.ts}, JavaScript: ${stats.js}, Other: ${stats.other}`);
        console.log(`- With patch: ${stats.withPatch}, Without patch: ${stats.withoutPatch}`);
        console.log(`- Processed: ${result.length} files`);
        return result;
    }
    /**
     * Получить текущий HEAD коммит PR
     */
    async getCurrentCommit(prNumber) {
        const { data: pr } = await (0, utils_1.withRetry)(() => this.octokit.pulls.get({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
        }));
        return pr.head.sha;
    }
    /**
     * Проверяет, что комментарий может быть добавлен к строке
     * (строка должна быть частью изменений в PR)
     */
    async validateComments(prNumber, comments) {
        try {
            // Получаем информацию о PR для проверки diff
            const { data: pr } = await (0, utils_1.withRetry)(() => this.octokit.pulls.get({
                owner: this.owner,
                repo: this.repo,
                pull_number: prNumber,
            }));
            // Получаем все измененные файлы
            const { data: files } = await (0, utils_1.withRetry)(() => this.octokit.pulls.listFiles({
                owner: this.owner,
                repo: this.repo,
                pull_number: prNumber,
                per_page: 100, // Увеличиваем количество файлов на страницу
            }));
            console.log(`Validating ${comments.length} comments against ${files.length} changed files`);
            // Создаем карту измененных строк для каждого файла
            const changedLinesMap = new Map();
            const filesWithoutPatch = new Set();
            for (const file of files) {
                if (file.patch) {
                    // Парсим diff чтобы получить измененные строки
                    const changedLines = new Set();
                    const diffLines = file.patch.split('\n');
                    let currentLine = 0;
                    for (const line of diffLines) {
                        if (line.startsWith('@@')) {
                            const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
                            if (match) {
                                currentLine = parseInt(match[1], 10) - 1;
                            }
                            continue;
                        }
                        if (line.startsWith('+')) {
                            changedLines.add(currentLine);
                        }
                        if (!line.startsWith('-')) {
                            currentLine++;
                        }
                    }
                    changedLinesMap.set(file.filename, changedLines);
                    console.log(`- ${file.filename}: extracted ${changedLines.size} changed lines`);
                }
                else {
                    // Отмечаем файлы без патча
                    filesWithoutPatch.add(file.filename);
                    console.log(`- ${file.filename}: no patch available, cannot validate lines`);
                }
            }
            // Фильтруем комментарии
            const validComments = [];
            const invalidComments = [];
            const lineIssues = [];
            for (const comment of comments) {
                // Проверяем существование файла в изменениях
                if (filesWithoutPatch.has(comment.path)) {
                    // Для файлов без патча, мы не можем проверить строки, но пробуем добавить комментарий
                    console.log(`File ${comment.path} has no patch. Adding comment at line ${comment.line} unchecked.`);
                    validComments.push(comment);
                    continue;
                }
                const changedLines = changedLinesMap.get(comment.path);
                if (!changedLines) {
                    console.error(`File ${comment.path} not found in changed files`);
                    invalidComments.push(comment);
                    lineIssues.push({ path: comment.path, line: comment.line, reason: 'file_not_changed' });
                    continue;
                }
                if (!changedLines.has(comment.line)) {
                    console.error(`Line ${comment.line} in ${comment.path} is not part of the diff`);
                    lineIssues.push({ path: comment.path, line: comment.line, reason: 'line_not_changed' });
                    // Попробуем найти ближайшую измененную строку
                    const sortedLines = Array.from(changedLines).sort((a, b) => a - b);
                    const closestLine = sortedLines.reduce((closest, current) => {
                        return Math.abs(current - comment.line) < Math.abs(closest - comment.line) ? current : closest;
                    }, sortedLines[0] || 1);
                    console.log(`Closest changed line to ${comment.line} is ${closestLine}`);
                    // Создаем новый комментарий с измененной строкой, но помечаем это в тексте
                    if (Math.abs(closestLine - comment.line) <= 5) { // Если близко
                        console.log(`Using closest line ${closestLine} instead of ${comment.line}`);
                        validComments.push({
                            ...comment,
                            line: closestLine,
                            body: `[Note: This comment was originally meant for line ${comment.line}]\n\n${comment.body}`
                        });
                    }
                    else {
                        invalidComments.push(comment);
                    }
                    continue;
                }
                validComments.push(comment);
            }
            console.log(`Comment validation results: ${validComments.length} valid, ${invalidComments.length} invalid`);
            // Выводим детальную информацию о проблемах
            if (lineIssues.length > 0) {
                console.log('Issues with comment placement:');
                const issuesByReason = lineIssues.reduce((acc, issue) => {
                    acc[issue.reason] = (acc[issue.reason] || 0) + 1;
                    return acc;
                }, {});
                for (const [reason, count] of Object.entries(issuesByReason)) {
                    console.log(`- ${reason}: ${count} issues`);
                }
            }
            // Для диагностики, выведем первые несколько невалидных комментариев
            if (invalidComments.length > 0) {
                console.log('Sample invalid comments:');
                for (let i = 0; i < Math.min(invalidComments.length, 3); i++) {
                    const comment = invalidComments[i];
                    console.log(`- ${comment.path}:${comment.line} - Body: ${comment.body.substring(0, 30)}...`);
                }
            }
            return validComments;
        }
        catch (error) {
            console.error('Error validating comments:', error);
            return comments; // В случае ошибки возвращаем исходные комментарии
        }
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
        console.log(`Total comments before validation: ${comments.length}`);
        // Предварительно валидируем комментарии
        const validatedComments = await this.validateComments(prNumber, comments);
        if (validatedComments.length === 0) {
            console.log('No valid comments after validation');
            return;
        }
        console.log(`Creating review with ${validatedComments.length} validated comments`);
        try {
            console.log('Calling GitHub API to create review...');
            // Логируем первые 2 комментария для диагностики
            for (let i = 0; i < Math.min(validatedComments.length, 2); i++) {
                console.log(`Comment ${i + 1}:`, JSON.stringify({
                    path: validatedComments[i].path,
                    line: validatedComments[i].line,
                    body_sample: validatedComments[i].body.substring(0, 50) + '...'
                }));
            }
            const { data: review } = await (0, utils_1.withRetry)(() => this.octokit.pulls.createReview({
                owner: this.owner,
                repo: this.repo,
                pull_number: prNumber,
                event: 'COMMENT',
                comments: validatedComments,
            }));
            console.log(`Created review: ${review.html_url}`);
        }
        catch (error) {
            const githubError = error;
            console.error('Error creating review:', githubError.status ? `Status: ${githubError.status}` : '', githubError.message || '');
            if (githubError.status === 422) {
                console.error('Failed to create review. Some comments might be outside of the diff.');
                // Выводим полное сообщение об ошибке для диагностики
                console.log('Error details:', JSON.stringify(githubError));
                // Попытаемся создать комментарии по одному, чтобы определить проблемные
                console.log('Trying to create comments one by one to identify problematic ones...');
                let successCount = 0;
                let failCount = 0;
                for (let i = 0; i < validatedComments.length; i++) {
                    const comment = validatedComments[i];
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
                        console.log(`Created individual comment for ${comment.path}:${comment.line}`);
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
    async getChangedFiles(mergeRequestIid, sinceCommit) {
        console.log(`Getting changed files for MR !${mergeRequestIid}${sinceCommit ? ` since commit ${sinceCommit}` : ''}`);
        // Получаем данные о изменениях в MR
        const endpoint = `/projects/${this.projectId}/merge_requests/${mergeRequestIid}/changes`;
        const data = await this.makeRequest(endpoint);
        // Если указан коммит для фильтрации, получаем только файлы, измененные после этого коммита
        let filteredChanges = data.changes;
        if (sinceCommit) {
            try {
                // Получаем текущий HEAD коммит MR
                const headCommit = await this.getCurrentCommit(mergeRequestIid);
                if (headCommit === sinceCommit) {
                    console.log('Current HEAD commit is the same as last analyzed commit, no new changes');
                    return [];
                }
                // Получаем список коммитов в MR
                const commitsEndpoint = `/projects/${this.projectId}/merge_requests/${mergeRequestIid}/commits`;
                const { commits } = await this.makeRequest(commitsEndpoint);
                // Создаем множество файлов, измененных после указанного коммита
                const changedFilePaths = new Set();
                const fileToCommits = new Map();
                // Находим индекс lastAnalyzedCommit в списке коммитов
                const lastCommitIndex = commits.findIndex(c => c.id === sinceCommit || c.short_id === sinceCommit);
                if (lastCommitIndex === -1) {
                    console.warn(`Commit ${sinceCommit} not found in MR !${mergeRequestIid}`);
                }
                else {
                    // Получаем новые коммиты (после lastAnalyzedCommit)
                    const newCommits = commits.slice(0, lastCommitIndex);
                    console.log(`Found ${newCommits.length} new commits since ${sinceCommit}`);
                    // Для каждого коммита получаем измененные файлы
                    for (const commit of newCommits) {
                        try {
                            const commitEndpoint = `/projects/${this.projectId}/repository/commits/${commit.id}/diff`;
                            const { diffs } = await this.makeRequest(commitEndpoint);
                            for (const diff of diffs) {
                                changedFilePaths.add(diff.new_path);
                                // Привязываем коммит к файлу
                                if (!fileToCommits.has(diff.new_path)) {
                                    fileToCommits.set(diff.new_path, []);
                                }
                                fileToCommits.get(diff.new_path).push(commit.short_id);
                            }
                        }
                        catch (e) {
                            console.error(`Error getting commit details for ${commit.id}:`, e);
                        }
                    }
                    // Фильтруем изменения MR, оставляя только файлы, измененные в новых коммитах
                    filteredChanges = data.changes.filter(change => changedFilePaths.has(change.new_path));
                    console.log(`Filtered to ${filteredChanges.length} files that were modified since ${sinceCommit}`);
                }
            }
            catch (e) {
                console.error(`Error filtering files by commit changes:`, e);
                // В случае ошибки используем все файлы
                filteredChanges = data.changes;
            }
        }
        const result = [];
        // Обрабатываем изменения
        for (const change of filteredChanges) {
            if (change.new_path.match(/\.(ts|tsx|js|jsx)$/)) {
                try {
                    console.log(`Processing file: ${change.new_path}`);
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
            else {
                console.log(`Skipping non-TypeScript/JavaScript file: ${change.new_path}`);
            }
        }
        return result;
    }
    /**
     * Получить текущий HEAD коммит MR
     */
    async getCurrentCommit(mergeRequestIid) {
        const endpoint = `/projects/${this.projectId}/merge_requests/${mergeRequestIid}`;
        const mr = await this.makeRequest(endpoint);
        return mr.sha;
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
