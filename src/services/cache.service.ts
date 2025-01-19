import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { CircuitBreakerService } from './circuit-breaker.service';
import { redisConfig } from '../config/redis.config';
import { CacheResponse, CacheSource } from '../interfaces/cache-response.interface';

interface LocalCacheEntry {
  value: any;
  timestamp: number;
  hits: number;
  ttl?: number;
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly redis: Redis;
  private readonly localCache: Map<string, LocalCacheEntry>;
  private isConnected = false;
  private readonly localCacheTTL = 300000; // 5 minutos
  private readonly cleanupInterval = 60000; // 1 minuto

  private readonly healthCheckInterval = 30000; // 30 segundos
  private lastHealthCheckTime = 0;
  private healthCheckStatus = {
    lastSuccessful: false,
    consecutiveFailures: 0,
    lastError: null as Error | null,
    lastCheckTime: 0
  };

  constructor(private readonly circuitBreaker: CircuitBreakerService) {
    this.redis = new Redis(redisConfig);
    this.localCache = new Map();
    this.setupRedisListeners();
    this.startCleanupInterval();
  }

  private setupRedisListeners() {
    this.redis.on('error', (error) => {
      if (this.isConnected) {
        this.isConnected = false;
        this.logger.error(`❌ Conexión perdida con Redis: ${error.message}`, error.stack);
        // Intentar reconectar automáticamente
        setTimeout(() => this.redis.connect(), 5000);
      }
    });

    this.redis.on('connect', () => {
      if (!this.isConnected) {
        this.isConnected = true;
        this.logger.log('✅ Conexión establecida con Redis');
      }
    });

    this.redis.on('ready', () => {
      this.isConnected = true;
      this.logger.log('🟢 Redis listo para operaciones');
    });
  }

  private startCleanupInterval() {
    setInterval(() => {
      this.cleanupLocalCache();
    }, this.cleanupInterval);
  }

  private cleanupLocalCache() {
    const now = Date.now();
    let cleanedEntries = 0;
    
    for (const [key, entry] of this.localCache.entries()) {
      const ttl = entry.ttl || this.localCacheTTL;
      if (now - entry.timestamp > ttl) {
        this.localCache.delete(key);
        cleanedEntries++;
      }
    }
    
    if (cleanedEntries > 0) {
      this.logger.debug(`🧹 ${cleanedEntries} entradas expiradas eliminadas del caché local`);
    }
  }

  async get<T>(key: string): Promise<CacheResponse<T>> {
    return this.circuitBreaker.execute<T>(
      async () => {
        try {
          const value = await this.redis.get(key);
          if (value) {
            const parsed = JSON.parse(value);
            await this.setLocalCache(key, parsed);
            this.logger.debug(`⚡ Cache hit en Redis: ${key}`);
            return {
              success: true,
              data: parsed,
              source: 'redis'
            };
          }
          this.logger.debug(`❓ Cache miss en Redis: ${key}`);
          return { success: false, source: 'none' };
        } catch (error) {
          this.logger.error(`🔥 Error en operación Redis para key ${key}:`, error.stack);
          throw error;
        }
      },
      async () => {
        const localValue = this.getFromLocalCache(key);
        if (localValue) {
          this.logger.debug(`💾 Cache hit local: ${key}`);
          return {
            success: true,
            data: localValue,
            source: 'local'
          };
        }
        return { success: false, source: 'none' };
      },
      `get:${key}`
    );
  }

  async set(key: string, value: any, ttl?: number): Promise<CacheResponse> {
    return this.circuitBreaker.execute(
      async () => {
        try {
          const serialized = JSON.stringify(value);
          if (ttl) {
            await this.redis.setex(key, ttl, serialized);
          } else {
            await this.redis.set(key, serialized);
          }
          await this.setLocalCache(key, value, ttl);
          this.logger.debug(`💾 Cache establecido en Redis: ${key}`);
          return { success: true, source: 'redis' };
        } catch (error) {
          this.logger.error(`🔥 Error al establecer cache para ${key}:`, error.stack);
          throw error;
        }
      },
      async () => {
        await this.setLocalCache(key, value, ttl);
        return { success: true, source: 'local' };
      },
      `set:${key}`
    );
  }

  private async setLocalCache(key: string, value: any, ttl?: number): Promise<void> {
    const entry = this.localCache.get(key);
    this.localCache.set(key, {
      value,
      timestamp: Date.now(),
      hits: (entry?.hits || 0) + 1,
      ttl: ttl ? ttl * 1000 : undefined // Convertir TTL de segundos a milisegundos
    });
  }

  private getFromLocalCache(key: string): any | null {
    const entry = this.localCache.get(key);
    if (!entry) return null;

    const now = Date.now();
    const ttl = entry.ttl || this.localCacheTTL;

    if (now - entry.timestamp < ttl) {
      entry.hits++;
      return entry.value;
    }

    this.localCache.delete(key);
    return null;
  }

  async healthCheck(): Promise<CacheResponse<boolean>> {
    try {
      const pingPromise = this.redis.ping();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Health check timeout')), 3000);
      });
  
      const isPingSuccessful = await Promise.race([
        pingPromise,
        timeoutPromise
      ]) === 'PONG';
  
      this.lastHealthCheckTime = Date.now();
      this.isConnected = isPingSuccessful;
        
      if (isPingSuccessful) {
        this.logger.debug('✅ Health check exitoso');
        this.healthCheckStatus.consecutiveFailures = 0;
      } else {
        this.healthCheckStatus.consecutiveFailures++;
        this.logger.warn(`⚠️ Health check fallido: No PONG (Intento ${this.healthCheckStatus.consecutiveFailures})`);
      }
        
      return {
        success: true,
        source: 'redis' as CacheSource,
        data: isPingSuccessful,
        details: {
          consecutiveFailures: this.healthCheckStatus.consecutiveFailures,
          cached: false,
          lastCheck: new Date(this.lastHealthCheckTime).toISOString()
        }
      };
    } catch (error) {
      this.isConnected = false;
      this.healthCheckStatus.consecutiveFailures++;
  
      this.logger.error('❌ Health check fallido:', {
        error: error.message,
        consecutiveFailures: this.healthCheckStatus.consecutiveFailures,
        timestamp: new Date().toISOString()
      });
  
      throw error; // Dejar que el CircuitBreaker maneje el error
    }
  }

  async clearCache(): Promise<CacheResponse<void>> {
    try {
      // Primero limpiamos el caché local
      this.localCache.clear();
      
      // Luego intentamos limpiar Redis
      await this.redis.flushall();
      this.logger.log('🧹 Cache completamente limpiado (local y Redis)');
      
      return {
        success: true,
        source: 'redis'
      };
    } catch (error) {
      this.logger.error('❌ Error al limpiar cache:', error.stack);
      throw error;
    }
  }

  async delete(key: string): Promise<CacheResponse> {
    return this.circuitBreaker.execute(
      async () => {
        try {
          const deleted = await this.redis.del(key);
          this.localCache.delete(key);
          this.logger.debug(`🗑️ Cache eliminado para key: ${key}`);
          return {
            success: deleted > 0,
            source: 'redis'
          };
        } catch (error) {
          this.logger.error(`🔥 Error al eliminar cache para ${key}:`, error.stack);
          throw error;
        }
      },
      async () => {
        this.localCache.delete(key);
        return {
          success: true,
          source: 'local'
        };
      },
      `delete:${key}`
    );
  }

  getLocalCacheStats() {
    return {
      size: this.localCache.size,
      entries: Array.from(this.localCache.entries()).map(([key, entry]) => ({
        key,
        hits: entry.hits,
        age: Date.now() - entry.timestamp
      }))
    };
  }

  async disconnect(): Promise<void> {
    try {
      await this.redis.quit();
      this.localCache.clear();
      this.logger.log('👋 Desconectado de Redis y limpiado caché local');
    } catch (error) {
      this.logger.error('❌ Error al desconectar:', error.stack);
      throw error;
    }
  }
}
