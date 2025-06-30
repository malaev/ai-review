"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeFile = analyzeFile;
const deepseek_1 = require("../ai/deepseek");
const levenshtein_1 = require("../utils/levenshtein");
const normalize_1 = require("../utils/normalize");
function findMostSimilarLine(targetLine, fileLines, startLine, endLine) {
    let bestMatch = {
        lineNumber: startLine,
        similarity: Infinity,
    };
    const normalizedTarget = (0, normalize_1.normalizeCode)(targetLine);
    const searchStart = Math.max(0, startLine - 30);
    const searchEnd = Math.min(fileLines.length, endLine + 30);
    for (let i = searchStart; i < searchEnd; i++) {
        const normalizedLine = (0, normalize_1.normalizeCode)(fileLines[i]);
        const distance = (0, levenshtein_1.levenshteinDistance)(normalizedTarget, normalizedLine);
        const similarity = distance / Math.max(normalizedTarget.length, normalizedLine.length);
        if (similarity < bestMatch.similarity) {
            bestMatch = {
                lineNumber: i + 1,
                similarity: similarity,
            };
        }
    }
    return bestMatch;
}
async function analyzeFile({ file, prInfo, fileContent, deepseekApiKey, }) {
    // Ограничение размера файла
    let content = fileContent;
    if (content.length > 30000) {
        content = content.slice(0, 30000);
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
    { "issues": [ { "line": number, "code": "string", "type": "quality" | "security" | "performance", "description": "string" } ] }`;
    let analysis;
    try {
        analysis = await (0, deepseek_1.analyzeCode)({
            apiKey: deepseekApiKey,
            systemPrompt,
            code: content,
        });
    }
    catch (error) {
        return [];
    }
    if (!analysis.issues || !Array.isArray(analysis.issues)) {
        return [];
    }
    const fileLines = content.split('\n');
    return analysis.issues
        .filter((issue) => typeof issue.line === 'number' &&
        typeof issue.code === 'string' &&
        typeof issue.type === 'string' &&
        typeof issue.description === 'string')
        .map(issue => {
        const match = findMostSimilarLine(issue.code, fileLines, Math.max(0, issue.line - 30), Math.min(fileLines.length, issue.line + 30));
        if (match.similarity > 0.3) {
            return null;
        }
        return {
            path: file.filename,
            line: match.lineNumber,
            body: `### ${issue.type === 'quality' ? '📝' : issue.type === 'security' ? '🔒' : '⚡'} ${issue.type.charAt(0).toUpperCase() + issue.type.slice(1)}\n${issue.description}\n\n*Чтобы задать вопрос, начните текст с @ai или /ai*`
        };
    })
        .filter((comment) => comment !== null);
}
