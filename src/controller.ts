import { CodeReviewPlatform, createPlatformAdapter } from './adapter';
import { ReviewComment, analyzeCodeContent, generateReplyForComment, parseDiffToChangedLines } from './utils';
import * as dotenv from 'dotenv';

// Загружаем переменные окружения
dotenv.config();

/**
 * Конфигурация для контроллера код-ревью
 */
export interface CodeReviewControllerConfig {
  platform: 'github' | 'gitlab';
  platformOptions: {
    token: string;
    repository?: string;
    projectId?: string;
    apiUrl?: string;
  };
  deepseekApiKey: string;
  deepseekApiUrl: string;
}

/**
 * Контроллер для управления процессом код-ревью
 */
export class CodeReviewController {
  private platform: CodeReviewPlatform;
  private config: CodeReviewControllerConfig;

  /**
   * Создает новый контроллер для код-ревью
   * @param config Конфигурация контроллера
   */
  constructor(config: CodeReviewControllerConfig) {
    this.config = config;
    this.platform = createPlatformAdapter(config.platform, config.platformOptions);
  }

  /**
   * Обработать событие Pull Request / Merge Request
   * @param prId ID Pull Request / Merge Request
   */
  async handlePullRequestEvent(prId: number | string): Promise<void> {
    console.log(`Analyzing ${this.config.platform === 'github' ? 'PR' : 'MR'} #${prId}...`);

    // Получаем измененные файлы
    const files = await this.platform.getChangedFiles(prId);
    console.log(`Found ${files.length} changed files`);

    // Анализируем каждый файл
    const allComments: ReviewComment[] = [];

    for (const file of files) {
      console.log(`Analyzing file: ${file.path}`);
      try {
        // Получаем результаты анализа
        const fileComments = await analyzeCodeContent(
          file.path,
          file.content,
          this.config.deepseekApiKey,
          this.config.deepseekApiUrl
        );

        // Фильтруем комментарии, оставляя только те, которые относятся к измененным строкам
        if (file.patch) {
          const changedLines = parseDiffToChangedLines(file.patch);
          const validComments = fileComments.filter(comment => changedLines.has(comment.line));

          console.log(`Found ${fileComments.length} issues, ${validComments.length} in changed lines`);
          allComments.push(...validComments);
        } else {
          console.log(`Found ${fileComments.length} issues (no patch available)`);
          allComments.push(...fileComments);
        }
      } catch (error) {
        console.error(`Error analyzing file ${file.path}:`, error);
      }
    }

    // Создаем ревью с комментариями
    if (allComments.length > 0) {
      console.log(`Creating ${allComments.length} review comments`);
      await this.platform.createReview(prId, allComments);
      console.log('Review created successfully');
    } else {
      console.log('No issues found, no review created');
    }
  }

  /**
   * Обработать событие комментария в PR/MR
   * @param commentId ID комментария
   */
  async handleCommentEvent(commentId: string | number): Promise<void> {
    console.log(`Processing comment ${commentId}...`);

    try {
      // Получаем информацию о комментарии
      const comment = await this.platform.getComment(commentId);

      // Проверяем, что комментарий содержит обращение к боту
      if (!comment.body.match(/^(@ai|\/ai)\s/i)) {
        console.log('Comment does not start with @ai or /ai, ignoring');
        return;
      }

      // Получаем список всех комментариев в PR/MR
      const allComments = await this.platform.listComments(comment.prId);

      // Ищем родительский комментарий от бота в той же строке
      const parentComment = allComments
        .reverse()
        .find(c =>
          c.id !== comment.id &&
          c.path === comment.path &&
          c.line === comment.line &&
          c.body.match(/### (📝|🔒|⚡) (Quality|Security|Performance)/i)
        );

      if (!parentComment) {
        console.error('Could not find parent bot comment');
        return;
      }

      // Получаем содержимое файла
      // В GitLab MR, в GitHub PR
      const ref = this.config.platform === 'github'
        ? `pull/${comment.prId}/head`
        : `refs/merge-requests/${comment.prId}/head`;

      const fileContent = await this.platform.getFileContent(comment.path, ref);

      // Убираем @ai или /ai из вопроса
      const question = comment.body.replace(/^(@ai|\/ai)\s+/i, '');

      console.log('Generating reply...');

      // Генерируем ответ
      const answer = await generateReplyForComment(
        comment.path,
        fileContent,
        comment.line,
        question,
        parentComment.body,
        this.config.deepseekApiKey,
        this.config.deepseekApiUrl
      );

      console.log('Sending reply...');

      // Отправляем ответ
      const replyBody = `> ${question}\n\n${answer}\n\n*Чтобы задать еще вопрос, начните текст с @ai или /ai*`;
      await this.platform.replyToComment(comment.prId, commentId, replyBody);

      console.log('Reply sent successfully');
    } catch (error) {
      console.error('Error handling comment:', error);
    }
  }

  /**
   * Основная функция для выбора и выполнения действия в зависимости от типа события
   * @param eventType Тип события ('pull_request', 'merge_request', 'comment', 'note')
   * @param eventData Данные события 
   */
  async processEvent(eventType: string, eventData: any): Promise<void> {
    console.log(`Processing ${eventType} event`);

    try {
      switch (eventType) {
        case 'pull_request': // GitHub
          await this.handlePullRequestEvent(eventData.pull_request.number);
          break;

        case 'merge_request': // GitLab
          await this.handlePullRequestEvent(eventData.object_attributes.iid);
          break;

        case 'pull_request_review_comment': // GitHub comment
          await this.handleCommentEvent(eventData.comment.id);
          break;

        case 'note': // GitLab comment
          // Проверяем, что это комментарий к MR, а не к Issue или Commit
          if (eventData.object_attributes.noteable_type === 'MergeRequest') {
            // В GitLab мы должны создать составной идентификатор
            const commentId = `${eventData.merge_request.iid}:${eventData.object_attributes.discussion_id}:${eventData.object_attributes.id}`;
            await this.handleCommentEvent(commentId);
          } else {
            console.log(`Ignoring note for ${eventData.object_attributes.noteable_type}`);
          }
          break;

        default:
          console.log(`Unsupported event type: ${eventType}`);
      }
    } catch (error) {
      console.error('Error processing event:', error);
      throw error;
    }
  }
}

/**
 * Создать контроллер из переменных окружения
 */
export function createControllerFromEnv(): CodeReviewController {
  // Получение общих настроек
  const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
  const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions';

  if (!DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is required');
  }

  // Определяем, какая платформа используется
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
    // GitHub конфигурация
    return new CodeReviewController({
      platform: 'github',
      platformOptions: {
        token: process.env.GITHUB_TOKEN,
        repository: process.env.GITHUB_REPOSITORY,
      },
      deepseekApiKey: DEEPSEEK_API_KEY,
      deepseekApiUrl: DEEPSEEK_API_URL,
    });
  } else if (process.env.GITLAB_TOKEN && process.env.GITLAB_PROJECT_ID) {
    // GitLab конфигурация
    return new CodeReviewController({
      platform: 'gitlab',
      platformOptions: {
        token: process.env.GITLAB_TOKEN,
        projectId: process.env.GITLAB_PROJECT_ID,
        apiUrl: process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4',
      },
      deepseekApiKey: DEEPSEEK_API_KEY,
      deepseekApiUrl: DEEPSEEK_API_URL,
    });
  } else {
    throw new Error('Missing platform configuration. Set either GITHUB_TOKEN and GITHUB_REPOSITORY or GITLAB_TOKEN and GITLAB_PROJECT_ID');
  }
} 