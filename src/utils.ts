import fetch from 'node-fetch';

// Максимальное количество попыток для API запросов
export const MAX_RETRIES = 3;
export const RETRY_DELAY = 1000;

// Интерфейсы для работы с анализом кода
export interface ReviewComment {
  path: string;
  line: number;
  body: string;
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

    return analysis.issues
      .filter((issue): issue is AnalysisIssueWithCode =>
        typeof issue.line === 'number' &&
        typeof issue.code === 'string' &&
        typeof issue.type === 'string' &&
        typeof issue.description === 'string'
      )
      .map(issue => {
        // Ищем наиболее похожую строку
        const match = findMostSimilarLine(
          issue.code,
          fileLines,
          Math.max(0, issue.line - 30),
          Math.min(fileLines.length, issue.line + 30)
        );

        // Если сходство слишком низкое (больше 0.3), пропускаем комментарий
        if (match.similarity > 0.3) {
          console.log(`Skipping comment for line ${issue.line} due to low similarity (${match.similarity})`);
          return null;
        }

        return {
          path: filePath,
          line: match.lineNumber,
          body: `### ${issue.type === 'quality' ? '📝' : issue.type === 'security' ? '🔒' : '⚡'} ${issue.type.charAt(0).toUpperCase() + issue.type.slice(1)}\n${issue.description}\n\n*Чтобы задать вопрос, начните текст с @ai или /ai*`
        };
      })
      .filter((comment): comment is ReviewComment => comment !== null);
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