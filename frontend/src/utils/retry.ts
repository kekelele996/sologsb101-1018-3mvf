/**
 * 前台写入重试
 * 接单前台写 IndexedDB 失败时，只重试「前台自己那份」委托单写入，
 * 绝不重放工序台（胎体 / 道次）的任何操作，避免把两边搅在一起。
 */

export interface RetryOptions {
  /** 最大尝试次数（含首次），默认 3 */
  attempts?: number;
  /** 每次失败后的退避（毫秒），默认 120ms，逐次翻倍 */
  baseDelayMs?: number;
  /** 判定错误是否值得重试；默认可重试（Quota / 事务锁等瞬时错误） */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_DELAY = 120;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 仅重试传入的同一个写函数：调用方必须保证 operation 只触碰前台表（commissions），
 * 且重试安全（Dexie put 按主键幂等）。
 */
export async function retryFrontDeskWrite<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelay = options.baseDelayMs ?? DEFAULT_DELAY;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const canRetry = attempt < attempts && (options.shouldRetry ? options.shouldRetry(error, attempt) : true);
      if (!canRetry) break;
      await wait(baseDelay * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('前台委托单写入失败');
}
