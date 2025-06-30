import fetch from 'node-fetch';
import { AnalysisResponseWithCode } from '../adapters/types';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

export class DeepSeekError extends Error {
  constructor(message: string, public details?: any) {
    super(message);
    this.name = 'DeepSeekError';
  }
}

export async function analyzeCode({
  apiKey,
  systemPrompt,
  code,
  temperature = 0.3,
  max_tokens = 4000,
}: {
  apiKey: string;
  systemPrompt: string;
  code: string;
  temperature?: number;
  max_tokens?: number;
}): Promise<AnalysisResponseWithCode> {
  const response = await fetch(DEEPSEEK_API_URL, {
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

  const data = await response.json() as { choices: [{ message: { content: string } }] };
  try {
    return JSON.parse(data.choices[0].message.content) as AnalysisResponseWithCode;
  } catch (error) {
    throw new DeepSeekError('Failed to parse DeepSeek response', data.choices[0].message.content);
  }
} 