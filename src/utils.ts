import fetch from 'node-fetch';
import type { Response as NodeFetchResponse } from 'node-fetch';

// Максимальное количество попыток для API запросов
export const MAX_RETRIES = 3;
export const RETRY_DELAY = 1000;

// Интерфейсы для работы с анализом кода
export interface ReviewComment {
  path: string;
  line: number;
  body: string;
  similarity?: number;
  originalCode?: string;
  matchedPatch?: string;
}

export interface AnalysisIssue {
  line: number;
  type: 'quality' | 'security' | 'performance';
  description: string;
}

export interface AnalysisIssueWithCode extends AnalysisIssue {
  code: string;  // Добавляем поле для хранения проблемной строки
}

export interface AnalysisResponse {
  issues: AnalysisIssue[];
}

export interface AnalysisResponseWithCode {
  issues: AnalysisIssueWithCode[];
}

export interface DeepSeekResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

// Утилита для задержки
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Утилита для повторных попыток
export async function withRetry<T>(operation: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
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

// Функция для вычисления расстояния Левенштейна между строками
export function levenshteinDistance(a: string, b: string): number {
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
export function normalizeCode(code: string): string {
  return code.trim().replace(/\s+/g, ' ');
}

// Функция для поиска наиболее похожей строки
export function findMostSimilarLine(targetLine: string, fileLines: string[], startLine: number, endLine: number): { lineNumber: number, similarity: number } {
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

// Функция для анализа файла с помощью DeepSeek API
export async function analyzeCodeContent(
  filePath: string,
  content: string,
  deepseekApiKey: string,
  deepseekApiUrl: string
): Promise<ReviewComment[]> {
  try {
    // Проверяем размер контента
    if (content.length > 30000) {
      console.log(`File ${filePath} is too large (${content.length} chars), analyzing first 30000 chars`);
      content = content.slice(0, 30000);
    }

    const lines = content.split('\n');

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
      2. Саму проблемную строку кода (code) - УКАЖИТЕ ТОЛЬКО ИЗМЕНЕННУЮ СТРОКУ КОДА, а не весь блок
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

    // Добавляем обработку таймаутов и повторные попытки для DeepSeek API
    const response = await withRetry(
      async () => {
        const fetchPromise = fetch(deepseekApiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${deepseekApiKey}`,
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
        });

        // Добавляем таймаут в 30 секунд
        const timeoutPromise = new Promise<Response>((_, reject) => {
          setTimeout(() => reject(new Error('DeepSeek API request timed out after 30s')), 30000);
        });

        // Используем Promise.race для обработки таймаутов
        return await Promise.race([fetchPromise, timeoutPromise]) as Response;
      },
      5  // Увеличиваем количество попыток
    );

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

    const data = await response.json() as DeepSeekResponse;
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

    const result = [];

    for (const issue of analysis.issues) {
      // Проверяем, что у нас есть все необходимые поля
      if (!issue.line || typeof issue.line !== 'number' ||
        !issue.code || typeof issue.code !== 'string' ||
        !issue.type || typeof issue.type !== 'string' ||
        !issue.description || typeof issue.description !== 'string') {
        console.log(`Skipping issue with invalid format:`, issue);
        continue;
      }

      // Нормализуем строку кода из анализа
      const normalizedIssueCode = normalizeCode(issue.code);

      // Ищем наиболее похожую строку в более широком диапазоне
      const searchRangeStart = Math.max(0, issue.line - 50);
      const searchRangeEnd = Math.min(fileLines.length, issue.line + 50);

      // Ищем наиболее похожую строку в этом диапазоне
      const match = findMostSimilarLine(
        issue.code,
        fileLines,
        searchRangeStart,
        searchRangeEnd
      );

      // Увеличиваем порог схожести до 0.5 (было 0.3)
      // Это означает, что мы принимаем строки, которые похожи на 50% и более
      if (match.similarity > 0.5) {
        console.log(`Skipping comment for line ${issue.line} due to low similarity (${match.similarity})`);
        continue;
      }

      // Проверяем, что строка не выходит за пределы файла
      if (match.lineNumber <= 0 || match.lineNumber > fileLines.length) {
        console.log(`Skipping comment for line ${match.lineNumber}: invalid line number`);
        continue;
      }

      result.push({
        path: filePath,
        line: match.lineNumber,
        body: `### ${issue.type === 'quality' ? '📝' : issue.type === 'security' ? '🔒' : '⚡'} ${issue.type.charAt(0).toUpperCase() + issue.type.slice(1)}\n${issue.description}\n\n*Чтобы задать вопрос, начните текст с @ai или /ai*`
      });
    }

    return result;
  } catch (error) {
    console.error(`Error analyzing file ${filePath}:`, error);
    if (error instanceof Error) {
      console.error('Error stack:', error.stack);
    }
    return [];
  }
}

// Функция для генерации ответа на вопрос о коде
export async function generateReplyForComment(
  filePath: string,
  fileContent: string,
  line: number,
  question: string,
  parentComment: string,
  deepseekApiKey: string,
  deepseekApiUrl: string
): Promise<string> {
  try {
    // Получаем контекст кода (25 строк до и после)
    const lines = fileContent.split('\n');
    const startLine = Math.max(0, line - 25);
    const endLine = Math.min(lines.length, line + 25);
    const codeContext = lines.slice(startLine, endLine).join('\n');

    // Извлекаем тип проблемы из родительского комментария
    const typeMatch = parentComment.match(/### (📝|🔒|⚡) (Quality|Security|Performance)/i);
    const type = typeMatch ? typeMatch[2].toLowerCase() : 'quality';

    const response = await withRetry(() => fetch(deepseekApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: `Вы эксперт по проверке кода для React + TypeScript проектов.
              Вы оставили комментарий о проблеме типа "${type}" в следующем коде (строка ${line}):
              
              \`\`\`typescript
              ${codeContext}
              \`\`\`
              
              Ваш комментарий был:
              ${parentComment.split('\n\n')[0]}\n${parentComment.split('\n\n')[1]}
              
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

    const data = await response.json() as DeepSeekResponse;
    return data.choices[0].message.content;
  } catch (error) {
    console.error('Error generating reply:', error);
    return 'Извините, произошла ошибка при генерации ответа. Пожалуйста, попробуйте еще раз позже.';
  }
}

// Функция для анализа измененных строк из diff
export function parseDiffToChangedLines(patch: string): Set<number> {
  const changedLines = new Set<number>();
  const diffLines = patch.split('\n');
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

  return changedLines;
}

// Определим тип для API-комментария
interface AIComment {
  code: string;
  comment: string;
}

// Функция для вычисления похожести двух строк
export function calculateSimilarity(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;
  if (str1 === str2) return 1.0;

  // Простое сравнение: длина общего префикса / максимальная длина строк
  let i = 0;
  const minLen = Math.min(str1.length, str2.length);

  while (i < minLen && str1[i] === str2[i]) {
    i++;
  }

  // Базовая оценка по префиксу
  let score = i / Math.max(str1.length, str2.length);

  // Если строки имеют общий префикс, улучшим оценку, проверив суффикс
  if (score > 0.3) {
    let j = 0;
    while (j < minLen &&
      str1[str1.length - 1 - j] === str2[str2.length - 1 - j] &&
      (str1.length - 1 - j) > i &&
      (str2.length - 1 - j) > i) {
      j++;
    }

    // Учитываем и префикс, и суффикс
    score = (i + j) / Math.max(str1.length, str2.length);
  }

  return score;
}

// Функция для генерации комментариев для изменений
export async function generateCommentsForChanges(
  filePath: string,
  codeChanges: string,
  fileContent: string | null,
  repo: string
): Promise<AIComment[]> {
  console.log(`Generating comments for ${filePath} in repo ${repo}`);

  // Проверим, что у нас есть что анализировать
  if (!codeChanges || codeChanges.trim().length === 0) {
    console.log(`No code changes to analyze for ${filePath}`);
    return [];
  }

  // Используем DeepSeek API для анализа
  const messages = [
    {
      role: "system", content:
        `You are a code review assistant. Your task is to review code changes and provide helpful comments.
      Focus on code quality, potential bugs, security issues, and best practices.
      For each issue, quote the specific code it applies to, and provide a clear explanation.
      Be concise and specific. Don't comment on trivial issues.`
    },
    {
      role: "user", content:
        `Review the following code changes in file ${filePath} from repository ${repo}.
      
      Here's the code:
      \`\`\`
      ${codeChanges}
      \`\`\`
      
      ${fileContent ? `For context, here's the full file content:
      \`\`\`
      ${fileContent}
      \`\`\`
      ` : ''}
      
      Respond in the following format for each issue found:
      - Code: <paste the exact code the comment applies to>
      - Comment: <your review comment>
      
      If there are no issues worth commenting on, just respond with "No issues found."`
    }
  ];

  try {
    const payload = {
      model: "deepseek-chat",
      messages: messages,
      temperature: 0.3,
      max_tokens: 1024
    };

    // Вызов DeepSeek API
    const response = await fetchFromDeepSeekAPI(payload);
    const data = await response.json();

    // Обработка ответа
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      console.warn(`Unexpected response format from DeepSeek API for ${filePath}`);
      return [];
    }

    const content = data.choices[0].message.content;
    console.log(`DeepSeek API response for ${filePath}: ${content.length} chars`);

    // Разбор результатов
    const comments: AIComment[] = [];

    if (content.includes("No issues found")) {
      console.log(`No issues found for ${filePath}`);
      return [];
    }

    // Парсим комментарии из формата ответа AI
    const regex = /- Code:\s+```(?:\w+)?\s+([\s\S]+?)```\s+- Comment:\s+([\s\S]+?)(?=- Code:|$)/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const code = match[1].trim();
      const comment = match[2].trim();

      if (code && comment) {
        comments.push({ code, comment });
      }
    }

    // Если не нашли по основному регулярному выражению, попробуем альтернативные форматы
    if (comments.length === 0) {
      // Альтернативный формат: без кода в блоках
      const simpleRegex = /- Code:\s+([\s\S]+?)\s+- Comment:\s+([\s\S]+?)(?=- Code:|$)/g;
      while ((match = simpleRegex.exec(content)) !== null) {
        const code = match[1].trim();
        const comment = match[2].trim();

        if (code && comment) {
          comments.push({ code, comment });
        }
      }
    }

    console.log(`Parsed ${comments.length} comments from DeepSeek response for ${filePath}`);
    return comments;

  } catch (error) {
    console.error(`Error generating comments for ${filePath}:`, error);
    return [];
  }
}

export async function fetchFromDeepSeekAPI(
  payload: Record<string, any>,
  endpoint: string = 'https://api.deepseek.com/v1/chat/completions',
  retries: number = 3,
  initialDelay: number = 1000
): Promise<NodeFetchResponse> {
  console.log(`Calling DeepSeek API: ${endpoint}`);
  console.log(`Payload parameters: model=${payload.model}, temperature=${payload.temperature}`);

  let attempt = 0;
  let delay = initialDelay;

  while (attempt < retries) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify(payload),
      }) as NodeFetchResponse;

      if (response.ok) {
        console.log(`DeepSeek API call successful (${response.status})`);
        return response;
      } else {
        const errorText = await response.text();
        console.error(`DeepSeek API error (${response.status}): ${errorText}`);

        // Проверяем тип ошибки
        if (response.status === 429 || response.status >= 500) {
          // Только для ошибок, связанных с ограничением запросов или с сервером
          attempt++;
          console.log(`Retrying DeepSeek API call (attempt ${attempt}/${retries}) after ${delay}ms delay...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2; // Экспоненциальная задержка
          continue;
        }

        // Для других ошибок просто возвращаем ответ
        return response;
      }
    } catch (error) {
      attempt++;
      console.error(`Network error during DeepSeek API call (attempt ${attempt}/${retries}):`, error);

      if (attempt < retries) {
        console.log(`Retrying after ${delay}ms delay...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Failed to reach DeepSeek API after ${retries} attempts`);
}

export function findSimilarCodeInDiff(
  file: { changes: { added: string[][], deleted: string[][] } | null, content?: string },
  code: string,
  threshold: number = 0.7
): { similarity: number, line: number, column: number, patch: string } | null {
  // Вывести информацию о поиске для диагностики
  console.log(`Finding similar code in diff with threshold=${threshold}`);
  console.log(`Code to find (${code.length} chars): ${code.substring(0, 50)}${code.length > 50 ? '...' : ''}`);

  let lines: string[] = [];
  let changes: { start: number, end: number, content: string }[] = [];

  if (file.changes) {
    // Преобразуем добавленные изменения в формат для поиска
    if (file.changes.added && file.changes.added.length > 0) {
      for (const block of file.changes.added) {
        if (block.length >= 2) {
          const start = parseInt(block[0]);
          const content = block.slice(1).join('\n');
          changes.push({ start, end: start + block.length - 2, content });
        }
      }
    }

    // Если есть полное содержимое файла, используем его
    if (file.content) {
      lines = file.content.split('\n');
    } else {
      // Иначе просто соберем строки из всех блоков изменений
      const maxLine = Math.max(...changes.map(change => change.end));
      lines = new Array(maxLine + 1).fill('');
      for (const change of changes) {
        const changeLines = change.content.split('\n');
        for (let i = 0; i < changeLines.length; i++) {
          lines[change.start + i] = changeLines[i];
        }
      }
    }
  } else if (file.content) {
    lines = file.content.split('\n');
    // Считаем весь файл как одно изменение
    changes.push({ start: 0, end: lines.length - 1, content: file.content });
  } else {
    console.warn('File has no changes or content to search in');
    return null;
  }

  console.log(`Found ${changes.length} change blocks to search within`);

  let bestMatch = { similarity: 0, line: 0, column: 0, patch: '' };

  // Поиск по каждому блоку изменений
  for (const change of changes) {
    const changeContent = change.content;
    const similarity = calculateSimilarity(changeContent, code);

    // Для диагностики выводим информацию о лучших совпадениях
    if (similarity > 0.5) {
      console.log(`Found potential match with similarity ${similarity.toFixed(3)} at line ${change.start + 1}`);
    }

    if (similarity > bestMatch.similarity) {
      bestMatch = {
        similarity,
        line: change.start + 1,
        column: 1,
        patch: changeContent.substring(0, 100) + (changeContent.length > 100 ? '...' : '')
      };
    }
  }

  if (bestMatch.similarity >= threshold) {
    console.log(`Best match found: similarity=${bestMatch.similarity.toFixed(3)}, line=${bestMatch.line}`);
    return bestMatch;
  }

  if (bestMatch.similarity > 0) {
    console.log(`No match above threshold. Best was: similarity=${bestMatch.similarity.toFixed(3)}, line=${bestMatch.line}`);
  } else {
    console.log('No similarity found at all');
  }

  return null;
}

export async function generateReviewComments(
  diffData: Record<string, any>,
  getFileContent: (path: string) => Promise<string | null>,
  repo: string
): Promise<ReviewComment[]> {
  console.log(`Generating review comments for ${Object.keys(diffData).length} changed files in ${repo}`);

  const comments: ReviewComment[] = [];

  // Обработка каждого файла в диффе
  for (const [filePath, fileChanges] of Object.entries(diffData)) {
    console.log(`Processing file: ${filePath}`);

    // Проверяем, есть ли в файле изменения
    const changes = fileChanges.changes;
    if (!changes || (!changes.added || changes.added.length === 0)) {
      console.log(`- Skipping file with no added changes: ${filePath}`);
      continue;
    }

    // Получаем содержимое файла если возможно
    let fileContent: string | null = null;
    try {
      fileContent = await getFileContent(filePath);
      console.log(`- File content retrieved: ${fileContent ? fileContent.length : 0} bytes`);
    } catch (e) {
      console.warn(`- Could not get content for ${filePath}:`, e);
    }

    // Собираем блоки добавленного кода для анализа
    const addedCodeBlocks: string[] = [];
    for (const block of changes.added) {
      if (block.length >= 2) {
        const content = block.slice(1).join('\n');
        if (content.trim().length > 0) {
          addedCodeBlocks.push(content);
        }
      }
    }

    if (addedCodeBlocks.length === 0) {
      console.log(`- No meaningful added code blocks in ${filePath}`);
      continue;
    }

    console.log(`- Found ${addedCodeBlocks.length} code blocks to analyze`);

    try {
      // Анализируем код с помощью DeepSeek API
      const aiComments = await generateCommentsForChanges(
        filePath,
        addedCodeBlocks.join('\n\n'),
        fileContent,
        repo
      );

      console.log(`- AI generated ${aiComments.length} comments for ${filePath}`);

      // Преобразуем AI-комментарии в формат ReviewComment
      for (const aiComment of aiComments) {
        // Находим близкое совпадение в диффе
        const match = findSimilarCodeInDiff(
          { changes, content: fileContent || undefined },
          aiComment.code,
          0.7 // Порог похожести
        );

        if (match) {
          comments.push({
            path: filePath,
            body: aiComment.comment,
            line: match.line,
            similarity: match.similarity,
            originalCode: aiComment.code,
            matchedPatch: match.patch
          });
          console.log(`- Added comment for line ${match.line} with similarity ${match.similarity.toFixed(3)}`);
        } else {
          console.log(`- Could not find a match for comment: ${aiComment.comment.substring(0, 50)}...`);
        }
      }
    } catch (error) {
      console.error(`Error generating comments for ${filePath}:`, error);
    }
  }

  console.log(`Generated ${comments.length} total comments across all files`);
  return comments;
} 