import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { CacheResponse } from '../interfaces/cache-response.interface';

export interface RetryOptions {
  maxAttempts?: number;
  initialBackoff?: number;
  maxBackoff?: number;
  backoffMultiplier?: number;
  retryableErrors?: Array<string | RegExp>;
  context?: string;
}

@Injectable()
export class RetryService {
  private readonly isDevelopment = process.env.NODE_ENV !== 'production';
  // private readonly logger = new Logger(RetryService.name);
  
  private readonly defaultOptions: Required<RetryOptions> = {
    maxAttempts: 3,
    initialBackoff: 1000,
    maxBackoff: 5000,
    backoffMultiplier: 2,
    retryableErrors: [
      /ECONNREFUSED/,
      /ETIMEDOUT/,
      /ECONNRESET/,
      /connect failed/i,
      'CONNECTION_ERROR',
      'REDIS_NOT_CONNECTED'
    ],
    context: 'default'
  };

  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext('RetryService');
  }

  async execute<T>(
    operation: () => Promise<CacheResponse<T>>,
    options?: RetryOptions
  ): Promise<CacheResponse<T>> {
    const finalOptions = { ...this.defaultOptions, ...options };
    let lastError: Error;
    let backoff = finalOptions.initialBackoff;
    
    for (let attempt = 1; attempt <= finalOptions.maxAttempts; attempt++) {
      try {
        const result = await operation();
        
        if (attempt > 1) {
          // this.logger.log(`✅ Operación exitosa después de ${attempt} intentos`, {
          //   context: finalOptions.context,
          //   attempts: attempt
          // });
          this.logger.info({
            context:finalOptions.context,
            attempts: attempt
          }, `Operación exitosa después de ${attempt} intentos`);
        }
        
        return result;
      } catch (error) {
        lastError = error;
        const isRetryable = this.isRetryableError(error, finalOptions.retryableErrors);
        
        if (!isRetryable) {
          // this.logger.error(`❌ Error no recuperable en ${finalOptions.context}:`, {
          //   error: error.message,
          //   attempt,
          //   stack: error.stack
          // });
          this.logger.error({
            err: error,
            attempt,
            context: finalOptions.context
          }, `Error no recuperable`);
          throw error;
        }
        
        if (attempt === finalOptions.maxAttempts) {
          // this.logger.error(
          //   `❌ Máximo de reintentos alcanzado en ${finalOptions.context}:`,
          //   {
          //     error: error.message,
          //     attempts: attempt,
          //     totalTime: this.calculateTotalTime(finalOptions)
          //   }
          // );
          this.logger.error({
            err: error,
            attempts: attempt,
            totalTime: this.calculateTotalTime(finalOptions),
            context: finalOptions.context
          }, `Máximo de reintentos alcanzado`)

          return {
            success: false,
            source: 'none',
            error: `Max retries reached: ${error.message}`,
            details: {
              lastError: error.message,
              attempts: attempt,
              context: finalOptions.context
            }
          };
        }

        // Solo loguear en modo desarrollo o en intentos específicos
        if (this.isDevelopment || attempt % 2 === 0) {
          this.logger.warn({
            err: error,
            attempt,
            nextBackoff: backoff,
            maxAttempts: finalOptions.maxAttempts,
            context: finalOptions.context
          }, `Intento fallido - reintentando`);
        }

        // this.logger.warn(
        //   `⚠️ Intento ${attempt}/${finalOptions.maxAttempts} fallido en ${finalOptions.context}`,
        //   {
        //     error: error.message,
        //     nextBackoff: backoff,
        //     attempt
        //   }
        // );
        
        await this.delay(this.calculateBackoff(backoff, finalOptions));
        backoff = Math.min(
          backoff * finalOptions.backoffMultiplier,
          finalOptions.maxBackoff
        );
      }
    }

    // Este código nunca debería ejecutarse debido al manejo en el loop
    throw lastError;
  }

  private isRetryableError(error: Error, patterns: Array<string | RegExp>): boolean {
    const errorString = error.message + (error.stack || '');
    return patterns.some(pattern => {
      if (pattern instanceof RegExp) {
        return pattern.test(errorString);
      }
      return errorString.includes(pattern);
    });
  }

  private calculateBackoff(currentBackoff: number, options: Required<RetryOptions>): number {
    const jitter = currentBackoff * 0.2 * (Math.random() - 0.5);
    return Math.min(
      currentBackoff * options.backoffMultiplier + jitter,
      options.maxBackoff
    );
  }

  private calculateTotalTime(options: Required<RetryOptions>): number {
    let total = 0;
    let current = options.initialBackoff;
    
    for (let i = 0; i < options.maxAttempts; i++) {
      total += current;
      current = Math.min(
        current * options.backoffMultiplier,
        options.maxBackoff
      );
    }
    
    return total;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}