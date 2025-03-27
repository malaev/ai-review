"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodeReviewController = void 0;
exports.createControllerFromEnv = createControllerFromEnv;
const adapter_1 = require("./adapter");
const utils_1 = require("./utils");
const dotenv = __importStar(require("dotenv"));
// Загружаем переменные окружения
dotenv.config();
/**
 * Контроллер для управления процессом код-ревью
 */
class CodeReviewController {
    /**
     * Создает новый контроллер для код-ревью
     * @param config Конфигурация контроллера
     */
    constructor(config) {
        this.config = config;
        this.platform = (0, adapter_1.createPlatformAdapter)(config.platform, config.platformOptions);
    }
    /**
     * Обработать событие Pull Request / Merge Request
     * @param prId ID Pull Request / Merge Request
     */
    async handlePullRequestEvent(prId) {
        console.log(`Analyzing ${this.config.platform === 'github' ? 'PR' : 'MR'} #${prId}...`);
        // Проверяем, есть ли предыдущие запуски и последние проанализированные коммиты
        const lastAnalyzedCommit = process.env.LAST_ANALYZED_COMMIT;
        console.log(`Last analyzed commit: ${lastAnalyzedCommit || 'none (analyzing entire PR)'}`);
        // Получаем измененные файлы, с учетом последнего анализируемого коммита
        const files = await this.platform.getChangedFiles(prId, lastAnalyzedCommit);
        console.log(`Found ${files.length} changed files since last analysis`);
        if (files.length === 0) {
            console.log('No new changes to analyze');
            return;
        }
        // Фильтруем файлы, исключая те, у которых нет патча
        const filesWithPatches = files.filter(file => !!file.patch);
        if (filesWithPatches.length < files.length) {
            console.log(`${files.length - filesWithPatches.length} files without patches excluded from analysis`);
        }
        // Анализируем каждый файл
        const allComments = [];
        // Добавляем логирование для отслеживания измененных строк
        console.log('==== Detailed file analysis ====');
        for (const file of filesWithPatches) {
            console.log(`Analyzing file: ${file.path}`);
            try {
                // Добавляем логирование информации о файле
                console.log(`File details: ${file.path}`);
                console.log(`Has patch: ${!!file.patch}`);
                console.log(`Commits: ${file.commits ? file.commits.join(', ') : 'unknown'}`);
                if (file.patch) {
                    // Логируем первые несколько строк патча для диагностики
                    const patchPreview = file.patch.split('\n').slice(0, 3).join('\n');
                    console.log(`Patch preview: ${patchPreview}...`);
                    // Отображаем измененные строки
                    const changedLines = (0, utils_1.parseDiffToChangedLines)(file.patch);
                    console.log(`Changed lines: ${[...changedLines].slice(0, 10).join(', ')}${changedLines.size > 10 ? '...' : ''}`);
                }
                // Получаем результаты анализа
                const fileComments = await (0, utils_1.analyzeCodeContent)(file.path, file.content, this.config.deepseekApiKey, this.config.deepseekApiUrl);
                // Теперь мы гарантированно имеем файл с патчем
                const changedLines = (0, utils_1.parseDiffToChangedLines)(file.patch);
                // Добавляем детальное логирование каждого комментария
                for (const comment of fileComments) {
                    const inChangedLines = changedLines.has(comment.line);
                    console.log(`Comment for line ${comment.line}: ${inChangedLines ? 'VALID (in changed lines)' : 'SKIPPED (not in changed lines)'}`);
                }
                const validComments = fileComments.filter(comment => changedLines.has(comment.line));
                console.log(`Found ${fileComments.length} issues, ${validComments.length} in changed lines`);
                allComments.push(...validComments);
            }
            catch (error) {
                console.error(`Error analyzing file ${file.path}:`, error);
                if (error instanceof Error) {
                    console.error('Error stack:', error.stack);
                }
            }
        }
        // Получаем текущий HEAD коммит для сохранения
        let headCommit = null;
        try {
            headCommit = await this.platform.getCurrentCommit(prId);
            console.log(`Current HEAD commit: ${headCommit}`);
        }
        catch (error) {
            console.error('Failed to get current commit:', error);
        }
        // Создаем ревью с комментариями
        if (allComments.length > 0) {
            console.log(`Creating ${allComments.length} review comments`);
            // Логируем сводную информацию о комментариях
            const commentsByFile = {};
            for (const comment of allComments) {
                commentsByFile[comment.path] = (commentsByFile[comment.path] || 0) + 1;
            }
            console.log('Comment distribution by file:');
            for (const [path, count] of Object.entries(commentsByFile)) {
                console.log(`- ${path}: ${count} comments`);
            }
            // Добавляем информацию о текущем коммите в ревью, чтобы не анализировать этот коммит повторно
            if (headCommit) {
                console.log(`Adding review with comment to track current commit: ${headCommit}`);
                // При необходимости можно добавить комментарий с информацией о текущем коммите
                // allComments.push({
                //   path: allComments[0].path,
                //   line: allComments[0].line,
                //   body: `AI Review completed for commit ${headCommit}`
                // });
            }
            await this.platform.createReview(prId, allComments);
            console.log('Review created successfully');
            // Выводим информацию для сохранения текущего коммита
            if (headCommit) {
                console.log('===========================================');
                console.log('To only analyze new changes in future runs:');
                console.log(`export LAST_ANALYZED_COMMIT=${headCommit}`);
                console.log('===========================================');
            }
        }
        else {
            console.log('No issues found, no review created');
        }
    }
    /**
     * Обработать событие комментария в PR/MR
     * @param commentId ID комментария
     */
    async handleCommentEvent(commentId) {
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
                .find(c => c.id !== comment.id &&
                c.path === comment.path &&
                c.line === comment.line &&
                c.body.match(/### (📝|🔒|⚡) (Quality|Security|Performance)/i));
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
            const answer = await (0, utils_1.generateReplyForComment)(comment.path, fileContent, comment.line, question, parentComment.body, this.config.deepseekApiKey, this.config.deepseekApiUrl);
            console.log('Sending reply...');
            // Отправляем ответ
            const replyBody = `> ${question}\n\n${answer}\n\n*Чтобы задать еще вопрос, начните текст с @ai или /ai*`;
            await this.platform.replyToComment(comment.prId, commentId, replyBody);
            console.log('Reply sent successfully');
        }
        catch (error) {
            console.error('Error handling comment:', error);
        }
    }
    /**
     * Основная функция для выбора и выполнения действия в зависимости от типа события
     * @param eventType Тип события ('pull_request', 'merge_request', 'comment', 'note')
     * @param eventData Данные события
     */
    async processEvent(eventType, eventData) {
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
                    }
                    else {
                        console.log(`Ignoring note for ${eventData.object_attributes.noteable_type}`);
                    }
                    break;
                default:
                    console.log(`Unsupported event type: ${eventType}`);
            }
        }
        catch (error) {
            console.error('Error processing event:', error);
            throw error;
        }
    }
}
exports.CodeReviewController = CodeReviewController;
/**
 * Создать контроллер из переменных окружения
 */
function createControllerFromEnv() {
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
    }
    else if (process.env.GITLAB_TOKEN && process.env.GITLAB_PROJECT_ID) {
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
    }
    else {
        throw new Error('Missing platform configuration. Set either GITHUB_TOKEN and GITHUB_REPOSITORY or GITLAB_TOKEN and GITLAB_PROJECT_ID');
    }
}
