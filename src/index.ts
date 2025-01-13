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

async function analyzeFile(file: { filename: string, patch?: string }, prInfo: PullRequestInfo): Promise<ReviewComment[]> {
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

  const content = Buffer.from(fileContent.content, 'base64').toString();

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
    
    Для каждой найденной проблемы укажите:
    1. Номер строки (line)
    2. Тип проблемы (type: 'quality' | 'security' | 'performance')
    3. Описание проблемы (description)
    
    ВАЖНО: Ответ должен быть строго в формате JSON без дополнительных пояснений:
    {
      "issues": [
        {
          "line": number,
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
    throw new Error(`DeepSeek API error: ${response.statusText}`);
  }

  const data = await response.json() as { choices: [{ message: { content: string } }] };
  let analysis;

  try {
    analysis = JSON.parse(data.choices[0].message.content) as AnalysisResponse;
  } catch (error) {
    console.error('Failed to parse DeepSeek response:', error);
    console.log('Raw response:', data.choices[0].message.content);
    // Возвращаем пустой массив комментариев в случае ошибки
    return [];
  }

  if (!analysis.issues || !Array.isArray(analysis.issues)) {
    console.error('Invalid analysis format:', analysis);
    return [];
  }

  return analysis.issues
    .filter((issue): issue is AnalysisIssue =>
      typeof issue.line === 'number' &&
      typeof issue.type === 'string' &&
      typeof issue.description === 'string'
    )
    .map(issue => ({
      path: file.filename,
      line: issue.line,
      body: `### ${issue.type === 'quality' ? '📝' : issue.type === 'security' ? '🔒' : '⚡'} ${issue.type.charAt(0).toUpperCase() + issue.type.slice(1)}\n${issue.description}`
    }));
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

async function handleCommentReply(owner: string, repo: string, comment_id: number, reply_to_id: number) {
  console.log(`Обрабатываю ответ на комментарий ${reply_to_id}...`);

  // Получаем оригинальный комментарий, на который отвечаем
  const { data: originalComment } = await withRetry(() => octokit.issues.getComment({
    owner,
    repo,
    comment_id: reply_to_id,
  }));

  // Получаем новый комментарий с вопросом
  const { data: newComment } = await withRetry(() => octokit.issues.getComment({
    owner,
    repo,
    comment_id,
  }));

  if (!originalComment?.body || !newComment?.body) {
    console.error('Comment body is empty');
    return;
  }

  // Извлекаем контекст из оригинального комментария (тип проблемы и описание)
  const typeMatch = originalComment.body.match(/### (📝|🔒|⚡) (Quality|Security|Performance)/i);
  const type = typeMatch ? typeMatch[2].toLowerCase() : 'quality';

  // Формируем промпт с контекстом
  const systemPrompt = `Вы эксперт по проверке кода для React + TypeScript проектов.
    Вы оставили комментарий о проблеме типа "${type}" в коде.
    
    Оригинальный комментарий:
    ${originalComment.body}
    
    Пользователь задал вопрос:
    ${newComment.body}
    
    Ответьте на вопрос пользователя в контексте конкретной проблемы в коде.
    Используйте технический, но понятный язык.
    Если нужно, предложите конкретное решение проблемы.`;

  console.log('Анализирую вопрос...');
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
          content: newComment.body,
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

  const issueNumber = newComment.issue_url.split('/').pop();
  if (!issueNumber) {
    throw new Error('Could not extract issue number from URL');
  }

  console.log('Отправляю ответ...');
  await withRetry(() => octokit.issues.createComment({
    owner,
    repo,
    issue_number: parseInt(issueNumber, 10),
    body: answer,
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
    if (eventName === 'pull_request') {
      const pull_number = Number(PR_NUMBER);
      if (isNaN(pull_number)) {
        throw new Error(`Invalid PR number: ${PR_NUMBER}`);
      }
      await handlePRReview({ owner, repo, pull_number });
    } else if (eventName === 'issue_comment') {
      const comment_id = Number(process.env.COMMENT_ID);
      const reply_to_id = Number(process.env.REPLY_TO_ID);
      if (!comment_id || !reply_to_id) {
        throw new Error('Missing comment information');
      }
      await handleCommentReply(owner, repo, comment_id, reply_to_id);
    } else {
      throw new Error(`Unsupported event type: ${eventName}`);
    }
  } catch (error) {
    console.error('Error during code review:', error);
    process.exit(1);
  }
}

main(); 