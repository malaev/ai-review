import { Octokit } from '@octokit/rest';
import * as dotenv from 'dotenv';
import fetch from 'node-fetch';

// Загружаем переменные окружения
dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME;
let PR_NUMBER: string | undefined;

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

const octokit = new Octokit({
  auth: GITHUB_TOKEN,
});

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// Максимальное количество попыток для API запросов
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

interface PullRequestInfo {
  owner: string;
  repo: string;
  pull_number: number;
}

interface CodeAnalysis {
  quality: string[];
  security: string[];
  performance: string[];
}

interface DeepSeekResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

interface ConversationContext {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  code: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
}

interface ReviewComment {
  id: number;
  body?: string;
  path: string;
  line: number;
  pull_request_url?: string;
}

interface IssueComment {
  id: number;
  body?: string;
  issue_url: string;
}

interface DraftReviewComment {
  path: string;
  line: number;
  body: string;
}

interface AnalysisIssue {
  line: number;
  type: 'quality' | 'security' | 'performance';
  description: string;
}

interface AnalysisResponse {
  issues: AnalysisIssue[];
}

// Хранилище контекстов обсуждений
const conversationContexts = new Map<string, ConversationContext>();

// Утилита для задержки
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Утилита для повторных попыток
async function withRetry<T>(operation: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (retries > 0) {
      console.log(`Повторная попытка (осталось ${retries})...`);
      await delay(RETRY_DELAY);
      return withRetry(operation, retries - 1);
    }
    throw error;
  }
}

function chunkDiff(diff: string, maxChunkSize: number = 4000): string[] {
  if (!diff) {
    throw new Error('Diff is empty');
  }

  const lines = diff.split('\n');
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentSize = 0;

  for (const line of lines) {
    if (currentSize + line.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));
      currentChunk = [];
      currentSize = 0;
    }
    currentChunk.push(line);
    currentSize += line.length;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n'));
  }

  return chunks;
}

async function getDiff({ owner, repo, pull_number }: PullRequestInfo): Promise<string> {
  const response = await withRetry(() => octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: {
      format: 'diff',
    },
  }));

  if (typeof response.data === 'string') {
    return response.data;
  }

  throw new Error('Failed to get diff in correct format');
}

async function getCommentContext(owner: string, repo: string, comment_id: number): Promise<ConversationContext | null> {
  try {
    const { data: comment } = await withRetry(() => octokit.issues.getComment({
      owner,
      repo,
      comment_id,
    }));

    if (!comment?.body) {
      console.log('Comment body is empty');
      return null;
    }

    const prNumber = comment.issue_url.split('/').pop();
    if (!prNumber) {
      console.log('Could not extract PR number from URL');
      return null;
    }

    const { data: pr } = await withRetry(() => octokit.pulls.get({
      owner,
      repo,
      pull_number: parseInt(prNumber, 10),
    }));

    const contextKey = `${pr.number}-${comment_id}`;
    let context = conversationContexts.get(contextKey);

    if (!context) {
      const codeMatch = comment.body.match(/\`\`\`[\s\S]*?\`\`\`/);
      if (codeMatch) {
        context = {
          filePath: 'unknown',
          lineStart: 0,
          lineEnd: 0,
          code: codeMatch[0],
          messages: [{
            role: 'assistant',
            content: comment.body,
          }],
        };
        conversationContexts.set(contextKey, context);
      }
    }

    return context || null;
  } catch (error) {
    console.error('Error getting comment context:', error);
    return null;
  }
}

async function analyzeCodeWithDeepSeek(chunk: string, context?: ConversationContext): Promise<string> {
  if (!chunk) {
    throw new Error('Empty chunk provided for analysis');
  }

  const systemPrompt = context
    ? `Вы эксперт по проверке кода для React + TypeScript проектов. Вы участвуете в обсуждении кода. 
       Контекст обсуждения:
       Файл: ${context.filePath}
       Строки: ${context.lineStart}-${context.lineEnd}
       Код:
       ${context.code}
       
       Предыдущие сообщения:
       ${context.messages.map(m => `${m.role}: ${m.content}`).join('\n')}
       
       Ответьте на последний вопрос пользователя, учитывая весь контекст обсуждения.`
    : `Вы эксперт по проверке кода для React + TypeScript проектов. Проанализируйте следующий diff и предоставьте структурированный отзыв по трем категориям:
       1. Качество кода (форматирование, читаемость, следование лучшим практикам, наличие типизации)
       2. Безопасность (уязвимости, обработка данных, аутентификация)
       3. Производительность (оптимизации React, управление состоянием, мемоизация, ошибки использования хуков)
       
       Формат ответа должен быть в виде JSON:
       {
         "quality": ["пункт 1", "пункт 2", ...],
         "security": ["пункт 1", "пункт 2", ...],
         "performance": ["пункт 1", "пункт 2", ...]
       }`;

  const response = await withRetry(() => fetch(DEEPSEEK_API_URL, {
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
          content: chunk,
        },
      ],
      response_format: context ? undefined : { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 2000,
    }),
  }));

  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${response.statusText}`);
  }

  const data = await response.json() as DeepSeekResponse;
  if (!data.choices?.[0]?.message?.content) {
    throw new Error('Invalid response from DeepSeek API');
  }

  return data.choices[0].message.content;
}

// Функция для вычисления расстояния Левенштейна между строками
function levenshteinDistance(a: string, b: string): number {
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));

  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1, // deletion
        matrix[j - 1][i] + 1, // insertion
        matrix[j - 1][i - 1] + substitutionCost // substitution
      );
    }
  }

  return matrix[b.length][a.length];
}

// Функция для нормализации строки кода (убирает пробелы, табуляцию и т.д.)
function normalizeCode(code: string): string {
  return code.trim().replace(/\s+/g, ' ');
}

// Функция для поиска наиболее похожей строки
function findMostSimilarLine(targetLine: string, fileLines: string[], startLine: number, endLine: number): number {
  let bestMatch = {
    lineNumber: startLine,
    similarity: Infinity,
  };

  const normalizedTarget = normalizeCode(targetLine);

  // Ищем в диапазоне ±10 строк от предполагаемой позиции
  const searchStart = Math.max(0, startLine - 10);
  const searchEnd = Math.min(fileLines.length, endLine + 10);

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

  // Если сходство слишком низкое, возвращаем изначальную строку
  return bestMatch.similarity < 0.5 ? bestMatch.lineNumber : startLine;
}

interface AnalysisIssueWithCode extends AnalysisIssue {
  code: string;  // Добавляем поле для хранения проблемной строки
}

interface AnalysisResponseWithCode {
  issues: AnalysisIssueWithCode[];
}

async function analyzeFile(file: { filename: string, patch?: string }, prInfo: PullRequestInfo): Promise<DraftReviewComment[]> {
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
    const lineMap = new Map<number, number>();
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

    const response = await withRetry(() => fetch(DEEPSEEK_API_URL, {
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

    const data = await response.json() as { choices: [{ message: { content: string } }] };
    let analysis;

    try {
      analysis = JSON.parse(data.choices[0].message.content) as AnalysisResponseWithCode;
    } catch (error) {
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
      .filter((issue): issue is AnalysisIssueWithCode =>
        typeof issue.line === 'number' &&
        typeof issue.code === 'string' &&
        typeof issue.type === 'string' &&
        typeof issue.description === 'string'
      )
      .map(issue => {
        const actualLine = findMostSimilarLine(
          issue.code,
          fileLines,
          Math.max(0, issue.line - 30),
          Math.min(fileLines.length, issue.line + 30)
        );

        return {
          path: file.filename,
          line: actualLine,
          body: `### ${issue.type === 'quality' ? '📝' : issue.type === 'security' ? '🔒' : '⚡'} ${issue.type.charAt(0).toUpperCase() + issue.type.slice(1)}\n${issue.description}\n\n*Чтобы задать вопрос, нажмите на три точки (⋯), выберите "Quote reply" и начните текст с @ai или /ai*`
        };
      });
  } catch (error) {
    console.error(`Error analyzing file ${file.filename}:`, error);
    if (error instanceof Error) {
      console.error('Error stack:', error.stack);
    }
    return [];
  }
}

interface GitHubError extends Error {
  status?: number;
}

async function commentOnPR(prInfo: PullRequestInfo) {
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
  const allComments = await Promise.all(
    files
      .filter(file => file.filename.match(/\.(ts|tsx|js|jsx)$/))
      .map(file => analyzeFile(file, prInfo))
  );

  // Фильтруем комментарии, оставляя только те, которые относятся к измененным строкам
  const validComments = allComments.flat().filter(comment => {
    const file = files.find(f => f.filename === comment.path);
    if (!file || !file.patch) return false;

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

    return changedLines.has(comment.line);
  });

  if (validComments.length === 0) {
    console.log('No valid comments to create');
    return;
  }

  // Создаем ревью с комментариями
  try {
    const { data: review } = await withRetry(() => octokit.pulls.createReview({
      owner: prInfo.owner,
      repo: prInfo.repo,
      pull_number: prInfo.pull_number,
      event: 'COMMENT',
      comments: validComments,
    }));
    console.log(`Created review: ${review.html_url}`);
  } catch (error: unknown) {
    const githubError = error as GitHubError;
    if (githubError.status === 422) {
      console.error('Failed to create review. Some comments might be outside of the diff.');
      console.log('Valid comments:', validComments);
    } else {
      throw error;
    }
  }
}

function formatAnalysisComment(analysis: CodeAnalysis): string {
  if (!analysis.quality?.length && !analysis.security?.length && !analysis.performance?.length) {
    return `## 🤖 AI Code Review

Код выглядит хорошо! Я не нашел существенных проблем.

---
*Этот отзыв был сгенерирован автоматически с помощью AI Code Review.*`;
  }

  return `## 🤖 AI Code Review

${analysis.quality.length ? `### 📝 Качество кода
${analysis.quality.map(item => `- ${item}`).join('\n')}` : ''}

${analysis.security.length ? `### 🔒 Безопасность
${analysis.security.map(item => `- ${item}`).join('\n')}` : ''}

${analysis.performance.length ? `### ⚡ Производительность
${analysis.performance.map(item => `- ${item}`).join('\n')}` : ''}

---
*Этот отзыв был сгенерирован автоматически с помощью AI Code Review.*`;
}

async function handlePRReview(prInfo: PullRequestInfo) {
  console.log(`Анализирую PR #${prInfo.pull_number}...`);

  console.log('Анализирую файлы и оставляю комментарии...');
  await commentOnPR(prInfo);
  console.log('Готово!');
}

// Добавляем интерфейс для сообщения в треде
interface ThreadMessage {
  id: number;
  body: string;
  isBot: boolean;
}

async function handleCommentReply(owner: string, repo: string, comment_id: number) {
  console.log(`Обрабатываю комментарий ${comment_id}...`);

  let comment: ReviewComment | IssueComment;
  let isReviewComment = false;

  // Сначала пробуем получить review comment
  try {
    const { data } = await withRetry(() => octokit.pulls.getReviewComment({
      owner,
      repo,
      comment_id,
    }));

    if (!data.path || data.id === undefined) {
      throw new Error('Required review comment data is missing');
    }

    comment = {
      id: data.id,
      body: data.body || '',
      path: data.path,
      line: data.line || 0,
      pull_request_url: `https://api.github.com/repos/${owner}/${repo}/pulls/${data.pull_request_review_id || 0}`,
    };
    isReviewComment = true;
    console.log('Найден review comment');
  } catch (error) {
    // Если не нашли review comment, пробуем обычный комментарий
    try {
      const { data } = await withRetry(() => octokit.issues.getComment({
        owner,
        repo,
        comment_id,
      }));

      if (!data.issue_url || data.id === undefined) {
        throw new Error('Required issue comment data is missing');
      }

      comment = {
        id: data.id,
        body: data.body || '',
        issue_url: data.issue_url,
      };
      console.log('Найден обычный комментарий');
    } catch (error) {
      console.error('Не удалось найти комментарий:', error);
      return;
    }
  }

  if (!comment?.body) {
    console.error('Comment body is empty');
    return;
  }

  // Проверяем, что комментарий содержит обращение к боту
  if (!comment.body.match(/^(@ai|\/ai)\s/i)) {
    console.log('Comment does not start with @ai or /ai, ignoring');
    return;
  }

  // Получаем родительский комментарий
  let parentComment;
  if (isReviewComment) {
    // Для review comments получаем все комментарии PR
    const prNumber = Number((comment as ReviewComment).pull_request_url?.split('/').pop() || '0');
    const { data: reviewComments } = await withRetry(() => octokit.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }));

    // Ищем родительский комментарий от бота
    parentComment = reviewComments
      .reverse()
      .find(c =>
        c.id < comment.id &&
        c.body?.match(/### (📝|🔒|⚡) (Quality|Security|Performance)/i)
      );
  } else {
    // Для обычных комментариев получаем все комментарии issue
    const issueNumber = Number((comment as IssueComment).issue_url.split('/').pop());
    const { data: comments } = await withRetry(() => octokit.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    }));

    // Ищем родительский комментарий от бота
    parentComment = comments
      .reverse()
      .find(c =>
        c.id < comment.id &&
        c.body?.match(/### (📝|🔒|⚡) (Quality|Security|Performance)/i)
      );
  }

  if (!parentComment?.body) {
    console.error('Could not find parent bot comment');
    return;
  }

  // Собираем историю обсуждения
  let threadHistory: ThreadMessage[] = [];

  const reviewComment = isReviewComment ? comment as ReviewComment : null;
  const issueComment = !isReviewComment ? comment as IssueComment : null;

  if (reviewComment?.pull_request_url) {
    const prNumber = Number(reviewComment.pull_request_url.split('/').pop() || '0');
    const { data: reviewComments } = await withRetry(() => octokit.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }));

    // Находим все комментарии в этом треде
    threadHistory = reviewComments
      .filter(c => c.id !== undefined && c.body !== undefined && c.body !== null)
      .map(c => ({
        id: c.id as number,
        body: c.body as string,
        isBot: (c.body as string).match(/### (📝|🔒|⚡) (Quality|Security|Performance)/i) !== null ||
          (c.body as string).match(/\*Чтобы задать еще вопрос/i) !== null,
      }));
  } else if (issueComment?.issue_url) {
    const issueNumber = Number(issueComment.issue_url.split('/').pop() || '0');
    const { data: comments } = await withRetry(() => octokit.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    }));

    // Находим все комментарии в этом треде
    threadHistory = comments
      .filter(c => c.id !== undefined && c.body !== undefined && c.body !== null)
      .map(c => ({
        id: c.id as number,
        body: c.body as string,
        isBot: (c.body as string).match(/### (📝|🔒|⚡) (Quality|Security|Performance)/i) !== null ||
          (c.body as string).match(/\*Чтобы задать еще вопрос/i) !== null,
      }));
  } else {
    console.log('Не удалось определить тип комментария или получить необходимые URL');
    return;
  }

  // Сортируем по времени
  threadHistory.sort((a, b) => a.id - b.id);

  // Формируем контекст обсуждения для API
  const conversationContext = threadHistory
    .map(msg => ({
      role: msg.isBot ? 'assistant' as const : 'user' as const,
      content: msg.body,
    }));

  // Извлекаем контекст из родительского комментария
  const typeMatch = parentComment.body.match(/### (📝|🔒|⚡) (Quality|Security|Performance)/i);
  const type = typeMatch ? typeMatch[2].toLowerCase() : 'quality';

  // Убираем @ai или /ai из вопроса
  const question = comment.body.replace(/^(@ai|\/ai)\s+/i, '');

  console.log('Анализирую вопрос с учетом истории обсуждения...');
  const response = await withRetry(() => fetch(DEEPSEEK_API_URL, {
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
            Вы участвуете в обсуждении проблемы типа "${type}" в коде.
            
            История обсуждения:
            ${threadHistory.map(msg => `${msg.isBot ? 'Бот' : 'Пользователь'}: ${msg.body}`).join('\n\n')}
            
            Ответьте на последний вопрос пользователя, учитывая весь контекст обсуждения.
            Используйте технический, но понятный язык.
            Если нужно, предложите конкретное решение проблемы.`,
        },
        ...conversationContext,
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

  const data = await response.json() as DeepSeekResponse;
  const answer = data.choices[0].message.content;

  console.log('Отправляю ответ...');
  if (isReviewComment) {
    // Отвечаем в thread review comment
    const prNumber = Number((comment as ReviewComment).pull_request_url?.split('/').pop() || '0');
    await withRetry(() => octokit.pulls.createReplyForReviewComment({
      owner,
      repo,
      pull_number: prNumber,
      comment_id: parentComment.id,
      body: `> ${question}\n\n${answer}\n\n*Чтобы задать еще вопрос, нажмите на три точки (⋯), выберите "Quote reply" и начните текст с @ai или /ai*`,
    }));
  } else {
    // Отвечаем в thread обычного комментария
    const issueNumber = Number((comment as IssueComment).issue_url.split('/').pop());
    await withRetry(() => octokit.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: `> ${question}\n\n${answer}\n\n*Чтобы задать еще вопрос, нажмите на три точки (⋯), выберите "Quote reply" и начните текст с @ai или /ai*`,
    }));
  }

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
    } else if (eventName === 'pull_request_review_comment' || eventName === 'issue_comment') {
      const comment_id = Number(process.env.COMMENT_ID);
      if (!comment_id) {
        throw new Error('Missing comment ID');
      }
      await handleCommentReply(owner, repo, comment_id);
    } else {
      throw new Error(`Unsupported event type: ${eventName}`);
    }
  } catch (error) {
    console.error('Error during code review:', error);
    process.exit(1);
  }
}

main(); 