import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { CacheResponse, CacheSource } from '../interfaces/cache-response.interface';

@Injectable()
export class CircuitBreakerService {
  private readonly isDevelopment = process.env.NODE_ENV !== 'production';
  // private readonly logger = new Logger(CircuitBreakerService.name);
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private failures = 0;
  private lastFailureTime: number = 0;
  private readonly threshold = 3;
  private readonly resetTimeout = 5000;  
  
  private metrics = {
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    lastFailure: null as Date | null,
    failureRate: 0,
    consecutiveFailures: 0
  };

  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext('CircuitBreakerService');
  }

  async execute<T>(
    operation: () => Promise<CacheResponse<T>>,
    fallback?: () => Promise<CacheResponse<T>>,
    context: string = 'default'
  ): Promise<CacheResponse<T>> {
    this.metrics.totalCalls++;

    if (this.isOpen()) {
      // this.logger.warn(`🔴 Circuit breaker ABIERTO para ${context} - Usando fallback`);
      this.logger.warn({ context, state: this.state }, 'Circuit breaker ABIERTO - Usando fallback');
      if (fallback) {
        return fallback();
      }
      return {
        success: false,
        source: 'none' as CacheSource,
        error: 'Circuit breaker is OPEN'
      };
    }

    try {
      const timeoutPromise = new Promise<CacheResponse<T>>((_, reject) => {
        setTimeout(() => reject(new Error('Operation timeout')), 3000);
      });

      const result = await Promise.race([operation(), timeoutPromise]) as CacheResponse<T>;
      this.onSuccess();
      this.metrics.successfulCalls++;
      this.metrics.consecutiveFailures = 0;
      return result;
    } catch (error) {
      this.onFailure();
      this.metrics.failedCalls++;
      this.metrics.lastFailure = new Date();
      this.metrics.consecutiveFailures++;
      this.metrics.failureRate = (this.metrics.failedCalls / this.metrics.totalCalls) * 100;
      
      this.logger.error({
        err: error,
        context,
        consecutiveFailures: this.metrics.consecutiveFailures,
        failureRate: this.metrics.failureRate.toFixed(2) + '%',
        state: this.state
      }, 'Operación fallida');
      
      if (fallback) {
        // this.logger.warn(`⚠️ Ejecutando fallback para ${context}`);
        this.logger.warn({ context }, 'Ejecutando fallback');
        return fallback();
      }
      
      return {
        success: false,
        source: 'none' as CacheSource,
        error: error.message,
        details: {
          lastError: error.message,
          consecutiveFailures: this.metrics.consecutiveFailures,
          lastCheck: new Date().toISOString()
        }
      };
    }
  }

  getMetrics() {
    return {
      ...this.metrics,
      currentState: this.state,
      failureThreshold: this.threshold,
      resetTimeoutMs: this.resetTimeout,
      lastStateChange: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null
    };
  }

  private isOpen(): boolean {
    if (this.state === 'OPEN') {
      const timeElapsed = Date.now() - this.lastFailureTime;
      if (timeElapsed >= this.resetTimeout) {
        this.state = 'HALF_OPEN';
        // this.logger.warn('🟡 Circuit breaker cambió a estado HALF_OPEN - Probando conexión');
        this.logger.warn({ newState: 'HALF_OPEN' }, 'Circuit breaker cambió a estado HALF_OPEN - Probando conexión');
        return false;
      }
      return true;
    }
    return false;
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      // this.logger.log('🟢 Circuit breaker restablecido a estado CLOSED - Conexión recuperada');
      this.logger.info({ newState: 'CLOSED' }, 'Circuit breaker restablecido a estado CLOSED - Conexión recuperada');
      this.failures = 0;
      this.state = 'CLOSED';
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    // this.logger.warn(`⚠️ Fallo detectado (${this.failures}/${this.threshold})`);
    // Solo loguear en desarrollo o si es un cambio importante
    if (this.isDevelopment || this.failures >= this.threshold) {
      this.logger.warn({ failures: this.failures, threshold: this.threshold }, 'Fallo detectado');
    }
    
    if (this.failures >= this.threshold && this.state !== 'OPEN') {
      this.state = 'OPEN';
      // this.logger.error(`🔴 Circuit breaker ABIERTO - ${this.failures} fallos consecutivos`, {
      //   failureRate: this.metrics.failureRate.toFixed(2) + '%',
      //   timeoutMs: this.resetTimeout,
      //   threshold: this.threshold
      // });
      this.logger.error({
        newState: 'OPEN', 
        failures: this.failures,
        failureRate: this.metrics.failureRate.toFixed(2) + '%',
        timeoutMs: this.resetTimeout,
        threshold: this.threshold
      }, 'Circuit breaker ABIERTO - Fallos consecutivos');
    }
  }

  getState(): string {
    return this.state;
  }

  reset(): void {
    this.state = 'CLOSED';
    this.failures = 0;
    this.lastFailureTime = 0;
    this.metrics = {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      lastFailure: null,
      failureRate: 0,
      consecutiveFailures: 0
    };
    // this.logger.log('🔄 Circuit breaker reseteado a estado inicial');
    this.logger.info('Circuit breaker reseteado a estado inicial');
  }
}

