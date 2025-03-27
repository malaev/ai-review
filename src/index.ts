import { Octokit } from '@octokit/rest';
import * as dotenv from 'dotenv';
import fetch from 'node-fetch';
import {
  MAX_RETRIES,
  RETRY_DELAY,
  ReviewComment,
  AnalysisIssue,
  AnalysisResponse,
  AnalysisIssueWithCode,
  AnalysisResponseWithCode,
  DeepSeekResponse,
  delay,
  withRetry,
  levenshteinDistance,
  normalizeCode,
  findMostSimilarLine,
  analyzeCodeContent,
  generateReplyForComment,
  parseDiffToChangedLines
} from './utils';

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

// Хранилище контекстов обсуждений
const conversationContexts = new Map<string, ConversationContext>();

async function analyzeFile(file: { filename: string, patch?: string }, prInfo: PullRequestInfo): Promise<ReviewComment[]> {
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

    const content = Buffer.from(fileContent.content, 'base64').toString();

    // Используем функцию из utils.ts для анализа содержимого файла
    const comments = await analyzeCodeContent(
      file.filename,
      content,
      DEEPSEEK_API_KEY!,
      DEEPSEEK_API_URL
    );

    return comments;
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

    // Используем функцию из utils.ts для парсинга diff
    const changedLines = parseDiffToChangedLines(file.patch);
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

async function handlePRReview(prInfo: PullRequestInfo) {
  console.log(`Анализирую PR #${prInfo.pull_number}...`);

  console.log('Анализирую файлы и оставляю комментарии...');
  await commentOnPR(prInfo);
  console.log('Готово!');
}

async function handleCommentReply(owner: string, repo: string, comment_id: number) {
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
    .find(c =>
      c.id < comment.id &&
      c.path === comment.path &&
      c.line === comment.line &&
      c.body?.match(/### (📝|🔒|⚡) (Quality|Security|Performance)/i)
    );

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

  // Убираем @ai или /ai из вопроса
  const question = comment.body.replace(/^(@ai|\/ai)\s+/i, '');

  console.log('Анализирую вопрос...');

  // Используем функцию из utils.ts для генерации ответа
  const answer = await generateReplyForComment(
    comment.path,
    content,
    comment.line,
    question,
    parentComment.body,
    DEEPSEEK_API_KEY!,
    DEEPSEEK_API_URL
  );

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
    body: `> ${question}\n\n${answer}\n\n*Чтобы задать еще вопрос, начните текст с @ai или /ai*`,
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
    } else if (eventName === 'pull_request_review_comment') {
      const comment_id = Number(process.env.COMMENT_ID);
      if (!comment_id) {
        throw new Error('Missing comment ID');
      }
      await handleCommentReply(owner, repo, comment_id);
    } else {
      console.log(`Ignoring event type: ${eventName}`);
    }
  } catch (error) {
    console.error('Error during code review:', error);
    process.exit(1);
  }
}

main(); 