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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const rest_1 = require("@octokit/rest");
const dotenv = __importStar(require("dotenv"));
const node_fetch_1 = __importDefault(require("node-fetch"));
// Загружаем переменные окружения
dotenv.config();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME;
let PR_NUMBER;
if (!GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is required');
}
if (!DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is required');
}
if (!GITHUB_REPOSITORY) {
    throw new Error('GITHUB_REPOSITORY is required');
}
const [owner, repo] = GITHUB_REPOSITORY.split('/');
// PR_NUMBER требуется только для события pull_request
if (GITHUB_EVENT_NAME === 'pull_request') {
    PR_NUMBER = process.env.PR_NUMBER;
    if (!PR_NUMBER) {
        throw new Error('PR_NUMBER is required for pull_request events');
    }
}
const octokit = new rest_1.Octokit({
    auth: GITHUB_TOKEN,
});
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
// Максимальное количество попыток для API запросов
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
// Хранилище контекстов обсуждений
const conversationContexts = new Map();
// Утилита для задержки
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// Утилита для повторных попыток
async function withRetry(operation, retries = MAX_RETRIES) {
    try {
        return await operation();
    }
    catch (error) {
        if (retries > 0) {
            console.log(`Повторная попытка (осталось ${retries})...`);
            await delay(RETRY_DELAY);
            return withRetry(operation, retries - 1);
        }
        throw error;
    }
}
// Функция для вычисления расстояния Левенштейна между строками
function levenshteinDistance(a, b) {
    const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
    for (let i = 0; i <= a.length; i++)
        matrix[0][i] = i;
    for (let j = 0; j <= b.length; j++)
        matrix[j][0] = j;
    for (let j = 1; j <= b.length; j++) {
        for (let i = 1; i <= a.length; i++) {
            const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[j][i] = Math.min(matrix[j][i - 1] + 1, // deletion
            matrix[j - 1][i] + 1, // insertion
            matrix[j - 1][i - 1] + substitutionCost // substitution
            );
        }
    }
    return matrix[b.length][a.length];
}
// Функция для нормализации строки кода (убирает пробелы, табуляцию и т.д.)
function normalizeCode(code) {
    return code.trim().replace(/\s+/g, ' ');
}
// Функция для поиска наиболее похожей строки
function findMostSimilarLine(targetLine, fileLines, startLine, endLine) {
    let bestMatch = {
        lineNumber: startLine,
        similarity: Infinity,
    };
    const normalizedTarget = normalizeCode(targetLine);
    // Ищем в диапазоне ±30 строк от предполагаемой позиции
    const searchStart = Math.max(0, startLine - 30);
    const searchEnd = Math.min(fileLines.length, endLine + 30);
    for (let i = searchStart; i < searchEnd; i++) {
        const normalizedLine = normalizeCode(fileLines[i]);
        const distance = levenshteinDistance(normalizedTarget, normalizedLine);
        // Нормализуем расстояние относительно длины строк
        const similarity = distance / Math.max(normalizedTarget.length, normalizedLine.length);
        if (similarity < bestMatch.similarity) {
            bestMatch = {
                lineNumber: i + 1, // +1 потому что нумерация строк с 1
                similarity: similarity,
            };
        }
    }
    return bestMatch;
}
async function analyzeFile(file, prInfo) {
    try {
        // Получаем содержимое файла
        const { data: fileContent } = await withRetry(() => octokit.repos.getContent({
            owner: prInfo.owner,
            repo: prInfo.repo,
            path: file.filename,
            ref: `pull/${prInfo.pull_number}/head`,
        }));
        if (!('content' in fileContent)) {
            throw new Error('File content not found');
        }
        let content = Buffer.from(fileContent.content, 'base64').toString();
        // Проверяем размер контента
        if (content.length > 30000) {
            console.log(`File ${file.filename} is too large (${content.length} chars), analyzing first 30000 chars`);
            content = content.slice(0, 30000);
        }
        const lines = content.split('\n');
        // Создаем карту соответствия строк в файле и в diff
        const lineMap = new Map();
        if (file.patch) {
            const diffLines = file.patch.split('\n');
            let fileLineNum = 0;
            let diffLineNum = 0;
            for (const line of diffLines) {
                if (line.startsWith('@@')) {
                    const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
                    if (match) {
                        fileLineNum = parseInt(match[1], 10) - 1;
                    }
                    continue;
                }
                if (!line.startsWith('-')) {
                    lineMap.set(fileLineNum + 1, diffLineNum + 1);
                    fileLineNum++;
                }
                diffLineNum++;
            }
        }
        const systemPrompt = `Вы опытный ревьюер React + TypeScript проектов.
      Проанализируйте код и найдите только серьезные проблемы, которые могут привести к багам или проблемам с производительностью.
      
      НЕ НУЖНО комментировать:
      - Стилистические проблемы
      - Отсутствие типов там, где они очевидны из контекста
      - Использование console.log
      - Мелкие предупреждения линтера
      - Отсутствие документации
      - Форматирование кода
      
      Сфокусируйтесь на:
      - Утечках памяти
      - Неправильном использовании React хуков
      - Потенциальных race conditions
      - Проблемах безопасности
      - Серьезных проблемах производительности
      - Логических ошибках в бизнес-логике
      
      ВАЖНО: Для каждой проблемы обязательно укажите:
      1. Точный номер строки (line)
      2. Саму проблемную строку кода (code)
      3. Тип проблемы (type)
      4. Описание проблемы (description)
      
      Ответ должен быть в формате JSON со следующей структурой:
      {
        "issues": [
          {
            "line": number,
            "code": "string", // Точная строка кода с проблемой
            "type": "quality" | "security" | "performance",
            "description": "string"
          }
        ]
      }`;
        const response = await withRetry(() => (0, node_fetch_1.default)(DEEPSEEK_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [
                    {
                        role: 'system',
                        content: systemPrompt,
                    },
                    {
                        role: 'user',
                        content: content,
                    },
                ],
                response_format: { type: 'json_object' },
                temperature: 0.3,
                max_tokens: 4000,
            }),
        }));
        if (!response.ok) {
            const errorText = await response.text();
            console.error('DeepSeek API error details:', {
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                body: errorText,
            });
            throw new Error(`DeepSeek API error: ${response.status} ${response.statusText}\n${errorText}`);
        }
        const data = await response.json();
        let analysis;
        try {
            analysis = JSON.parse(data.choices[0].message.content);
        }
        catch (error) {
            console.error('Failed to parse DeepSeek response:', error);
            console.log('Raw response:', data.choices[0].message.content);
            return [];
        }
        if (!analysis.issues || !Array.isArray(analysis.issues)) {
            console.error('Invalid analysis format:', analysis);
            return [];
        }
        // Разбиваем файл на строки для поиска
        const fileLines = content.split('\n');
        return analysis.issues
            .filter((issue) => typeof issue.line === 'number' &&
            typeof issue.code === 'string' &&
            typeof issue.type === 'string' &&
            typeof issue.description === 'string')
            .map(issue => {
            // Ищем наиболее похожую строку
            const match = findMostSimilarLine(issue.code, fileLines, Math.max(0, issue.line - 30), Math.min(fileLines.length, issue.line + 30));
            // Если сходство слишком низкое (больше 0.3), пропускаем комментарий
            if (match.similarity > 0.3) {
                console.log(`Skipping comment for line ${issue.line} due to low similarity (${match.similarity})`);
                return null;
            }
            return {
                path: file.filename,
                line: match.lineNumber,
                body: `### ${issue.type === 'quality' ? '📝' : issue.type === 'security' ? '🔒' : '⚡'} ${issue.type.charAt(0).toUpperCase() + issue.type.slice(1)}\n${issue.description}\n\n*Чтобы задать вопрос, нажмите на три точки (⋯), выберите "Quote reply" и начните текст с @ai или /ai*`
            };
        })
            .filter((comment) => comment !== null);
    }
    catch (error) {
        console.error(`Error analyzing file ${file.filename}:`, error);
        if (error instanceof Error) {
            console.error('Error stack:', error.stack);
        }
        return [];
    }
}
async function commentOnPR(prInfo) {
    // Получаем файлы, измененные в PR
    const { data: files } = await withRetry(() => octokit.pulls.listFiles({
        owner: prInfo.owner,
        repo: prInfo.repo,
        pull_number: prInfo.pull_number,
    }));
    // Получаем diff для каждого файла
    const { data: pr } = await withRetry(() => octokit.pulls.get({
        owner: prInfo.owner,
        repo: prInfo.repo,
        pull_number: prInfo.pull_number,
    }));
    // Анализируем каждый файл и собираем комментарии
    const allComments = await Promise.all(files
        .filter(file => file.filename.match(/\.(ts|tsx|js|jsx)$/))
        .map(file => analyzeFile(file, prInfo)));
    // Фильтруем комментарии, оставляя только те, которые относятся к измененным строкам
    const validComments = allComments.flat().filter(comment => {
        const file = files.find(f => f.filename === comment.path);
        if (!file || !file.patch)
            return false;
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
        return changedLines.has(comment.line);
    });
    if (validComments.length === 0) {
        console.log('No valid comments to create');
        return;
    }
    // Создаем ревью только с комментариями к измененным строкам
    try {
        const { data: review } = await withRetry(() => octokit.pulls.createReview({
            owner: prInfo.owner,
            repo: prInfo.repo,
            pull_number: prInfo.pull_number,
            event: 'COMMENT',
            comments: validComments,
        }));
        console.log(`Created review: ${review.html_url}`);
    }
    catch (error) {
        const githubError = error;
        if (githubError.status === 422) {
            console.error('Failed to create review. Some comments might be outside of the diff.');
            console.log('Valid comments:', validComments);
        }
        else {
            throw error;
        }
    }
}
async function handlePRReview(prInfo) {
    console.log(`Анализирую PR #${prInfo.pull_number}...`);
    console.log('Анализирую файлы и оставляю комментарии...');
    await commentOnPR(prInfo);
    console.log('Готово!');
}
async function handleCommentReply(owner, repo, comment_id) {
    console.log(`Обрабатываю комментарий ${comment_id}...`);
    // Получаем review comment
    const { data: comment } = await withRetry(() => octokit.pulls.getReviewComment({
        owner,
        repo,
        comment_id,
    }));
    if (!comment?.body || !comment.pull_request_url || !comment.line || !comment.path) {
        console.error('Required comment data is missing');
        return;
    }
    // Проверяем, что комментарий содержит обращение к боту
    if (!comment.body.match(/^(@ai|\/ai)\s/i)) {
        console.log('Comment does not start with @ai or /ai, ignoring');
        return;
    }
    // Получаем номер PR
    const prNumber = Number(comment.pull_request_url.split('/').pop());
    if (!prNumber) {
        console.error('Could not extract PR number from URL');
        return;
    }
    // Получаем все review comments в PR
    const { data: reviewComments } = await withRetry(() => octokit.pulls.listReviewComments({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
    }));
    // Ищем родительский комментарий от бота в той же строке
    const parentComment = reviewComments
        .reverse()
        .find(c => c.id < comment.id &&
        c.path === comment.path &&
        c.line === comment.line &&
        c.body?.match(/### (📝|🔒|⚡) (Quality|Security|Performance)/i));
    if (!parentComment?.body) {
        console.error('Could not find parent bot comment');
        return;
    }
    // Получаем содержимое файла
    const { data: fileContent } = await withRetry(() => octokit.repos.getContent({
        owner,
        repo,
        path: comment.path,
        ref: `pull/${prNumber}/head`,
    }));
    if (!('content' in fileContent)) {
        throw new Error('File content not found');
    }
    const content = Buffer.from(fileContent.content, 'base64').toString();
    const lines = content.split('\n');
    // Получаем контекст кода (25 строк до и после)
    const startLine = Math.max(0, comment.line - 25);
    const endLine = Math.min(lines.length, comment.line + 25);
    const codeContext = lines.slice(startLine, endLine).join('\n');
    // Извлекаем тип проблемы из родительского комментария
    const typeMatch = parentComment.body.match(/### (📝|🔒|⚡) (Quality|Security|Performance)/i);
    const type = typeMatch ? typeMatch[2].toLowerCase() : 'quality';
    // Убираем @ai или /ai из вопроса
    const question = comment.body.replace(/^(@ai|\/ai)\s+/i, '');
    console.log('Анализирую вопрос...');
    const response = await withRetry(() => (0, node_fetch_1.default)(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
                {
                    role: 'system',
                    content: `Вы эксперт по проверке кода для React + TypeScript проектов.
            Вы оставили комментарий о проблеме типа "${type}" в следующем коде (строка ${comment.line}):
            
            \`\`\`typescript
            ${codeContext}
            \`\`\`
            
            Ваш комментарий был:
            ${parentComment.body.split('\n\n')[0]}\n${parentComment.body.split('\n\n')[1]}
            
            Пользователь задал вопрос об этой проблеме:
            ${question}
            
            Ответьте на вопрос пользователя, объясняя проблему в контексте конкретной строки кода.
            Если пользователь просит показать как исправить, предложите конкретное решение с примером кода.
            Используйте технический, но понятный язык.`,
                },
                {
                    role: 'user',
                    content: question,
                },
            ],
            temperature: 0.3,
            max_tokens: 2000,
        }),
    }));
    if (!response.ok) {
        throw new Error(`DeepSeek API error: ${response.statusText}`);
    }
    const data = await response.json();
    const answer = data.choices[0].message.content;
    console.log('Отправляю ответ...');
    // Получаем информацию о PR для создания review comment
    const { data: pr } = await withRetry(() => octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
    }));
    await withRetry(() => octokit.pulls.createReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        body: `> ${question}\n\n${answer}\n\n*Чтобы задать еще вопрос, нажмите на три точки (⋯), выберите "Quote reply" и начните текст с @ai или /ai*`,
        commit_id: pr.head.sha,
        path: comment.path,
        line: comment.line,
        in_reply_to: comment.id,
    }));
    console.log('Готово!');
}
async function main() {
    const [owner, repo] = GITHUB_REPOSITORY?.split('/') || [];
    const eventName = process.env.GITHUB_EVENT_NAME;
    if (!owner || !repo) {
        throw new Error('Missing repository information');
    }
    try {
        console.log('Event type:', eventName);
        if (eventName === 'pull_request') {
            const pull_number = Number(PR_NUMBER);
            if (isNaN(pull_number)) {
                throw new Error(`Invalid PR number: ${PR_NUMBER}`);
            }
            await handlePRReview({ owner, repo, pull_number });
        }
        else if (eventName === 'pull_request_review_comment') {
            const comment_id = Number(process.env.COMMENT_ID);
            if (!comment_id) {
                throw new Error('Missing comment ID');
            }
            await handleCommentReply(owner, repo, comment_id);
        }
        else {
            console.log(`Ignoring event type: ${eventName}`);
        }
    }
    catch (error) {
        console.error('Error during code review:', error);
        process.exit(1);
    }
}
main();
