import { Octokit } from '@octokit/rest';
import 'dotenv/config';
import fetch from 'node-fetch';

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
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

interface DeepSeekResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

async function getDiff({ owner, repo, pull_number }: PullRequestInfo): Promise<string> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: {
      format: 'diff',
    },
  });

  if (typeof response.data === 'string') {
    return response.data;
  }

  throw new Error('Failed to get diff in correct format');
}

function chunkDiff(diff: string, maxChunkSize: number = 4000): string[] {
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

async function analyzeCodeWithDeepSeek(chunk: string): Promise<CodeAnalysis> {
  const response = await fetch(DEEPSEEK_API_URL, {
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
          content: `Вы эксперт по проверке кода для React и TypeScript проектов. Проанализируйте следующий diff и предоставьте структурированный отзыв по трем категориям:
          1. Качество кода (форматирование, читаемость, следование лучшим практикам)
          2. Безопасность (уязвимости, обработка данных, аутентификация)
          3. Производительность (оптимизации React, управление состоянием, мемоизация)
          
          Формат ответа должен быть в виде JSON:
          {
            "quality": ["пункт 1", "пункт 2", ...],
            "security": ["пункт 1", "пункт 2", ...],
            "performance": ["пункт 1", "пункт 2", ...]
          }`,
        },
        {
          role: 'user',
          content: chunk,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 2000,
    }),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek API error: ${response.statusText}`);
  }

  const data = await response.json() as DeepSeekResponse;
  return JSON.parse(data.choices[0].message.content || '{"quality":[],"security":[],"performance":[]}') as CodeAnalysis;
}

async function analyzeCode(diff: string): Promise<CodeAnalysis> {
  const chunks = chunkDiff(diff);
  const analyses = await Promise.all(chunks.map(analyzeCodeWithDeepSeek));

  return analyses.reduce((acc, curr) => ({
    quality: [...acc.quality, ...curr.quality],
    security: [...acc.security, ...curr.security],
    performance: [...acc.performance, ...curr.performance],
  }), { quality: [], security: [], performance: [] });
}

async function commentOnPR(prInfo: PullRequestInfo, analysis: CodeAnalysis) {
  const comment = formatAnalysisComment(analysis);
  await octokit.issues.createComment({
    owner: prInfo.owner,
    repo: prInfo.repo,
    issue_number: prInfo.pull_number,
    body: comment,
  });
}

function formatAnalysisComment(analysis: CodeAnalysis): string {
  return `## 🤖 AI Code Review

### 📝 Качество кода
${analysis.quality.map(item => `- ${item}`).join('\n')}

### 🔒 Безопасность
${analysis.security.map(item => `- ${item}`).join('\n')}

### ⚡ Производительность
${analysis.performance.map(item => `- ${item}`).join('\n')}

---
*Этот отзыв был сгенерирован автоматически с помощью AI Code Review.*`;
}

async function main() {
  const [owner, repo] = process.env.GITHUB_REPOSITORY?.split('/') || [];
  const pull_number = Number(process.env.GITHUB_EVENT_NUMBER);

  if (!owner || !repo || !pull_number) {
    throw new Error('Missing required environment variables');
  }

  if (!DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is required');
  }

  const prInfo = { owner, repo, pull_number };

  try {
    const diff = await getDiff(prInfo);
    const analysis = await analyzeCode(diff);
    await commentOnPR(prInfo, analysis);
  } catch (error) {
    console.error('Error during code review:', error);
    process.exit(1);
  }
}

main(); 