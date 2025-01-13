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
if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is required');
}
if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is required');
}
const octokit = new rest_1.Octokit({
    auth: process.env.GITHUB_TOKEN,
});
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
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
function chunkDiff(diff, maxChunkSize = 4000) {
    if (!diff) {
        throw new Error('Diff is empty');
    }
    const lines = diff.split('\n');
    const chunks = [];
    let currentChunk = [];
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
async function getDiff({ owner, repo, pull_number }) {
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
async function getCommentContext(owner, repo, comment_id) {
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
    }
    catch (error) {
        console.error('Error getting comment context:', error);
        return null;
    }
}
async function analyzeCodeWithDeepSeek(chunk, context) {
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
    const data = await response.json();
    if (!data.choices?.[0]?.message?.content) {
        throw new Error('Invalid response from DeepSeek API');
    }
    return data.choices[0].message.content;
}
async function commentOnPR(prInfo, analysis) {
    const comment = formatAnalysisComment(analysis);
    await withRetry(() => octokit.issues.createComment({
        owner: prInfo.owner,
        repo: prInfo.repo,
        issue_number: prInfo.pull_number,
        body: comment,
    }));
}
function formatAnalysisComment(analysis) {
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
async function handlePRReview(prInfo) {
    console.log(`Анализирую PR #${prInfo.pull_number}...`);
    const diff = await getDiff(prInfo);
    const chunks = chunkDiff(diff);
    console.log(`Разбил diff на ${chunks.length} частей`);
    const analyses = await Promise.all(chunks.map(chunk => analyzeCodeWithDeepSeek(chunk)));
    const analysis = analyses.reduce((acc, curr) => {
        const parsed = JSON.parse(curr);
        return {
            quality: [...acc.quality, ...parsed.quality],
            security: [...acc.security, ...parsed.security],
            performance: [...acc.performance, ...parsed.performance],
        };
    }, { quality: [], security: [], performance: [] });
    console.log('Отправляю комментарий...');
    await commentOnPR(prInfo, analysis);
    console.log('Готово!');
}
async function handleCommentReply(owner, repo, comment_id, reply_to_id) {
    console.log(`Обрабатываю ответ на комментарий ${reply_to_id}...`);
    const context = await getCommentContext(owner, repo, reply_to_id);
    if (!context) {
        console.error('Could not find context for comment');
        return;
    }
    const { data: comment } = await withRetry(() => octokit.issues.getComment({
        owner,
        repo,
        comment_id,
    }));
    if (!comment?.body) {
        console.error('Comment body is empty');
        return;
    }
    context.messages.push({
        role: 'user',
        content: comment.body,
    });
    console.log('Анализирую вопрос...');
    const response = await analyzeCodeWithDeepSeek(comment.body, context);
    context.messages.push({
        role: 'assistant',
        content: response,
    });
    const issueNumber = comment.issue_url.split('/').pop();
    if (!issueNumber) {
        throw new Error('Could not extract issue number from URL');
    }
    console.log('Отправляю ответ...');
    await withRetry(() => octokit.issues.createComment({
        owner,
        repo,
        issue_number: parseInt(issueNumber, 10),
        body: response,
    }));
    console.log('Готово!');
}
async function main() {
    const [owner, repo] = process.env.GITHUB_REPOSITORY?.split('/') || [];
    const eventName = process.env.GITHUB_EVENT_NAME;
    if (!owner || !repo) {
        throw new Error('Missing repository information');
    }
    try {
        if (eventName === 'pull_request') {
            const pull_number = Number(process.env.PR_NUMBER);
            if (!pull_number) {
                throw new Error('Missing PR number');
            }
            await handlePRReview({ owner, repo, pull_number });
        }
        else if (eventName === 'issue_comment') {
            const comment_id = Number(process.env.COMMENT_ID);
            const reply_to_id = Number(process.env.REPLY_TO_ID);
            if (!comment_id || !reply_to_id) {
                throw new Error('Missing comment information');
            }
            await handleCommentReply(owner, repo, comment_id, reply_to_id);
        }
        else {
            throw new Error(`Unsupported event type: ${eventName}`);
        }
    }
    catch (error) {
        console.error('Error during code review:', error);
        process.exit(1);
    }
}
main();
