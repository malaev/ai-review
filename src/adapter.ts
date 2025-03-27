import { Octokit } from '@octokit/rest';
import { ReviewComment, withRetry } from './utils';
import fetch from 'node-fetch';

// Общие интерфейсы

/**
 * Базовый интерфейс для получения данных из репозитория
 */
export interface SourceCodeProvider {
  /**
   * Получить содержимое файла из репозитория
   */
  getFileContent(path: string, ref: string): Promise<string>;

  /**
   * Получить список измененных файлов в PR/MR
   */
  getChangedFiles(prId: number | string): Promise<CodeFile[]>;
}

/**
 * Базовый интерфейс для работы с комментариями
 */
export interface CommentPlatform {
  /**
   * Создать ревью с комментариями в PR/MR
   */
  createReview(prId: number | string, comments: ReviewComment[]): Promise<void>;

  /**
   * Ответить на комментарий
   */
  replyToComment(prId: number | string, commentId: string | number, body: string, inReplyTo?: number | string): Promise<void>;
}

/**
 * Интерфейс для объединения работы с кодом и комментариями
 */
export interface CodeReviewPlatform extends SourceCodeProvider, CommentPlatform {
  /**
   * Получить информацию о комментарии в PR/MR
   */
  getComment(commentId: string | number): Promise<CommentInfo>;

  /**
   * Получить список комментариев в PR/MR
   */
  listComments(prId: number | string): Promise<CommentInfo[]>;
}

/**
 * Общая информация о файле с кодом
 */
export interface CodeFile {
  path: string;
  content: string;
  patch?: string;
}

/**
 * Общая информация о комментарии
 */
export interface CommentInfo {
  id: string | number;
  body: string;
  path: string;
  line: number;
  prId: number | string;
  createdAt: Date;
}

/**
 * Ошибка платформы
 */
export interface PlatformError extends Error {
  status?: number;
}

// GitHub Адаптер

/**
 * Адаптер для работы с GitHub API
 */
export class GitHubAdapter implements CodeReviewPlatform {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  /**
   * Создает новый адаптер для GitHub
   * @param token GitHub токен доступа
   * @param repository Репозиторий в формате owner/repo
   */
  constructor(token: string, repository: string) {
    this.octokit = new Octokit({ auth: token });
    [this.owner, this.repo] = repository.split('/');

    if (!this.owner || !this.repo) {
      throw new Error('Invalid repository format. Expected "owner/repo"');
    }
  }

  /**
   * Получить содержимое файла из GitHub
   */
  async getFileContent(path: string, ref: string): Promise<string> {
    const { data: fileContent } = await withRetry(() => this.octokit.repos.getContent({
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
  async getChangedFiles(prNumber: number): Promise<CodeFile[]> {
    const { data: files } = await withRetry(() => this.octokit.pulls.listFiles({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      per_page: 100, // Увеличиваем количество файлов на страницу
    }));

    const result: CodeFile[] = [];

    console.log(`Retrieved ${files.length} changed files from GitHub API for PR #${prNumber}`);
    
    // Считаем статистику для лучшей диагностики
    const stats = {
      total: files.length,
      ts: 0,
      js: 0,
      other: 0,
      withPatch: 0,
      withoutPatch: 0
    };

    for (const file of files) {
      // Обновляем статистику
      if (file.filename.match(/\.(ts|tsx)$/)) {
        stats.ts++;
      } else if (file.filename.match(/\.(js|jsx)$/)) {
        stats.js++;
      } else {
        stats.other++;
      }
      
      if (file.patch) {
        stats.withPatch++;
      } else {
        stats.withoutPatch++;
      }

      // Обрабатываем только TypeScript/JavaScript файлы
      if (file.filename.match(/\.(ts|tsx|js|jsx)$/)) {
        try {
          console.log(`Processing file: ${file.filename}`);
          console.log(`- Status: ${file.status}, Changes: +${file.additions}/-${file.deletions}, Has patch: ${Boolean(file.patch)}`);
          
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
          
          const content = await this.getFileContent(
            file.filename,
            `pull/${prNumber}/head`
          );

          result.push({
            path: file.filename,
            content,
            patch: file.patch
          });
        } catch (error) {
          console.error(`Error getting content for ${file.filename}:`, error);
          
          // Пытаемся все равно добавить файл, если есть патч
          if (file.patch) {
            result.push({
              path: file.filename,
              content: '', // Пустое содержимое
              patch: file.patch
            });
          }
        }
      } else {
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
   * Проверяет, что комментарий может быть добавлен к строке
   * (строка должна быть частью изменений в PR)
   */
  private async validateComments(prNumber: number, comments: ReviewComment[]): Promise<ReviewComment[]> {
    try {
      // Получаем информацию о PR для проверки diff
      const { data: pr } = await withRetry(() => this.octokit.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      }));

      // Получаем все измененные файлы
      const { data: files } = await withRetry(() => this.octokit.pulls.listFiles({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        per_page: 100, // Увеличиваем количество файлов на страницу
      }));

      console.log(`Validating ${comments.length} comments against ${files.length} changed files`);

      // Создаем карту измененных строк для каждого файла
      const changedLinesMap = new Map<string, Set<number>>();
      const filesWithoutPatch = new Set<string>();

      for (const file of files) {
        if (file.patch) {
          // Парсим diff чтобы получить измененные строки
          const changedLines = new Set<number>();
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
        } else {
          // Отмечаем файлы без патча
          filesWithoutPatch.add(file.filename);
          console.log(`- ${file.filename}: no patch available, cannot validate lines`);
        }
      }

      // Фильтруем комментарии
      const validComments: ReviewComment[] = [];
      const invalidComments: ReviewComment[] = [];
      const lineIssues: { path: string, line: number, reason: string }[] = [];

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
          } else {
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
        }, {} as Record<string, number>);
        
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
    } catch (error) {
      console.error('Error validating comments:', error);
      return comments; // В случае ошибки возвращаем исходные комментарии
    }
  }

  /**
   * Создать ревью с комментариями
   */
  async createReview(prNumber: number, comments: ReviewComment[]): Promise<void> {
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

      const { data: review } = await withRetry(() => this.octokit.pulls.createReview({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
        event: 'COMMENT',
        comments: validatedComments,
      }));
      console.log(`Created review: ${review.html_url}`);
    } catch (error: unknown) {
      const githubError = error as PlatformError;
      console.error('Error creating review:',
        githubError.status ? `Status: ${githubError.status}` : '',
        githubError.message || '');

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
            const { data: pr } = await withRetry(() => this.octokit.pulls.get({
              owner: this.owner,
              repo: this.repo,
              pull_number: prNumber,
            }));

            await withRetry(() => this.octokit.pulls.createReviewComment({
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
          } catch (commentError: any) {
            failCount++;
            console.error(`Failed to create comment ${i + 1} for ${comment.path}:${comment.line} -`,
              commentError.status || '',
              commentError.message || '');
          }
        }

        console.log(`Individual comment creation results: ${successCount} succeeded, ${failCount} failed`);
      } else {
        throw error;
      }
    }
  }

  /**
   * Ответить на комментарий в PR
   */
  async replyToComment(prNumber: number, commentId: number, body: string): Promise<void> {
    // Получаем информацию о PR для создания review comment
    const { data: pr } = await withRetry(() => this.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    }));

    const comment = await this.getComment(commentId);

    await withRetry(() => this.octokit.pulls.createReviewComment({
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
  async getComment(commentId: number): Promise<CommentInfo> {
    const { data: comment } = await withRetry(() => this.octokit.pulls.getReviewComment({
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
  async listComments(prNumber: number): Promise<CommentInfo[]> {
    const { data: reviewComments } = await withRetry(() => this.octokit.pulls.listReviewComments({
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

// GitLab Адаптер

/**
 * Адаптер для работы с GitLab API
 */
export class GitLabAdapter implements CodeReviewPlatform {
  private token: string;
  private projectId: string;
  private apiUrl: string;

  /**
   * Создает новый адаптер для GitLab
   * @param token GitLab токен доступа
   * @param projectId ID проекта в GitLab
   * @param apiUrl URL GitLab API (по умолчанию https://gitlab.com/api/v4)
   */
  constructor(token: string, projectId: string, apiUrl = 'https://gitlab.com/api/v4') {
    this.token = token;
    this.projectId = projectId;
    this.apiUrl = apiUrl;
  }

  /**
   * Создает запрос к GitLab API
   */
  private async makeRequest<T>(endpoint: string, method = 'GET', body?: any): Promise<T> {
    return withRetry(async () => {
      const response = await fetch(`${this.apiUrl}${endpoint}`, {
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

      return response.json() as Promise<T>;
    });
  }

  /**
   * Получить содержимое файла из GitLab
   */
  async getFileContent(path: string, ref: string): Promise<string> {
    const encodedPath = encodeURIComponent(path);
    const encodedRef = encodeURIComponent(ref);
    const endpoint = `/projects/${this.projectId}/repository/files/${encodedPath}/raw?ref=${encodedRef}`;

    const response = await withRetry(() => fetch(`${this.apiUrl}${endpoint}`, {
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
  async getChangedFiles(mergeRequestIid: string | number): Promise<CodeFile[]> {
    const endpoint = `/projects/${this.projectId}/merge_requests/${mergeRequestIid}/changes`;
    const data = await this.makeRequest<{ changes: Array<{ new_path: string, diff: string }> }>(endpoint);

    const result: CodeFile[] = [];

    for (const change of data.changes) {
      if (change.new_path.match(/\.(ts|tsx|js|jsx)$/)) {
        try {
          const content = await this.getFileContent(
            change.new_path,
            `refs/merge-requests/${mergeRequestIid}/head`
          );

          result.push({
            path: change.new_path,
            content,
            patch: change.diff
          });
        } catch (error) {
          console.error(`Error getting content for ${change.new_path}:`, error);
        }
      }
    }

    return result;
  }

  /**
   * Создать ревью с комментариями
   */
  async createReview(mergeRequestIid: number | string, comments: ReviewComment[]): Promise<void> {
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
  async replyToComment(mergeRequestIid: number | string, discussionId: string, body: string): Promise<void> {
    const endpoint = `/projects/${this.projectId}/merge_requests/${mergeRequestIid}/discussions/${discussionId}/notes`;
    await this.makeRequest(endpoint, 'POST', { body });
  }

  /**
   * Получить информацию о комментарии
   */
  async getComment(noteId: string | number): Promise<CommentInfo> {
    // В GitLab нет прямого пути к получению заметки по ID,
    // поэтому нужно получить информацию о MR и затем найти заметку
    const { mrIid, discussionId } = await this.findNoteContext(noteId);

    // Получаем дискуссию
    const endpoint = `/projects/${this.projectId}/merge_requests/${mrIid}/discussions/${discussionId}`;
    const discussion = await this.makeRequest<any>(endpoint);

    // Находим нужную заметку
    const note = discussion.notes.find((n: any) => n.id.toString() === noteId.toString());
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
  private async findNoteContext(noteId: string | number): Promise<{ mrIid: string, discussionId: string }> {
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
  async listComments(mergeRequestIid: string | number): Promise<CommentInfo[]> {
    const endpoint = `/projects/${this.projectId}/merge_requests/${mergeRequestIid}/discussions`;
    const discussions = await this.makeRequest<any[]>(endpoint);

    const comments: CommentInfo[] = [];

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

/**
 * Создать соответствующий адаптер платформы контроля версий
 */
export function createPlatformAdapter(platform: 'github' | 'gitlab', options: any): CodeReviewPlatform {
  switch (platform) {
    case 'github':
      return new GitHubAdapter(options.token, options.repository);
    case 'gitlab':
      return new GitLabAdapter(options.token, options.projectId, options.apiUrl);
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
} 