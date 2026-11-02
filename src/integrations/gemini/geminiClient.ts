import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../../config';

let genAI: GoogleGenerativeAI | null = null;

export function getGeminiClient(): GoogleGenerativeAI {
  if (!genAI) {
    if (!config.GEMINI_API_KEY) {
      console.warn('[Gemini] WARNING: GEMINI_API_KEY is not set. Gemini API calls will run in fallback/mock mode.');
    }
    genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY || 'MOCK_KEY');
  }
  return genAI;
}

export async function callGeminiWithBackoff<T>(
  fn: () => Promise<T>,
  retries = 3,
  delayMs = 1000
): Promise<T> {
  let attempt = 0;
  while (attempt < retries) {
    try {
      return await fn();
    } catch (error: any) {
      attempt++;
      const isRateLimit =
        error?.status === 429 ||
        error?.message?.includes('429') ||
        error?.message?.includes('RESOURCE_EXHAUSTED');

      if (attempt >= retries || !isRateLimit) {
        throw error;
      }

      const backoff = delayMs * Math.pow(2, attempt - 1) + Math.random() * 200;
      console.warn(`[Gemini] Rate limit encountered. Retrying attempt ${attempt}/${retries} in ${Math.round(backoff)}ms...`);
      await new Promise((res) => setTimeout(res, backoff));
    }
  }
  throw new Error('Gemini API maximum retries exceeded');
}

