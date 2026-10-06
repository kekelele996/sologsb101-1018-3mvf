/**
 * 写入重试工具
 * 前台（委托单）写入失败后只重试自己那份：
 * - 委托单在创建时即固定主键，重试同一 put 幂等，不会产生重复委托单；
 * - 重试只重放委托单这一份写入，不重放胎体回写等关联副作用，避免越补越乱。
 */

/**
 * 幂等写入重试：同一写操作（同一主键 put）失败时重试，最大 maxAttempts 次。
 * 每次重试之间线性退避；重试仍失败则抛出最后一次错误，由调用方提示。
 */
export async function retryIdempotentWrite<T>(
  write: () => Promise<T>,
  maxAttempts = 3,
  delayMs = 80,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  throw lastError;
}
