export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function withRetry<T>(operation: () => Promise<T>, retries = 3, retryDelay = 1000): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (retries > 0) {
      await delay(retryDelay);
      return withRetry(operation, retries - 1, retryDelay);
    }
    throw error;
  }
} 