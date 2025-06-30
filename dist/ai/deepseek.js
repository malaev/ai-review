"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeepSeekError = void 0;
exports.analyzeCode = analyzeCode;
const node_fetch_1 = __importDefault(require("node-fetch"));
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
class DeepSeekError extends Error {
    constructor(message, details) {
        super(message);
        this.details = details;
        this.name = 'DeepSeekError';
    }
}
exports.DeepSeekError = DeepSeekError;
async function analyzeCode({ apiKey, systemPrompt, code, temperature = 0.3, max_tokens = 4000, }) {
    const response = await (0, node_fetch_1.default)(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: code },
            ],
            response_format: { type: 'json_object' },
            temperature,
            max_tokens,
        }),
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new DeepSeekError(`DeepSeek API error: ${response.status} ${response.statusText}`, errorText);
    }
    const data = await response.json();
    try {
        return JSON.parse(data.choices[0].message.content);
    }
    catch (error) {
        throw new DeepSeekError('Failed to parse DeepSeek response', data.choices[0].message.content);
    }
}
