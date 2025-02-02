import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { CircuitBreakerService } from './circuit-breaker.service';
import { redisConfig, RedisConfigWithCompression } from '../config/redis.config';
import { CacheResponse, CacheSource } from '../interfaces/cache-response.interface';
import { RetryService } from './retry-service';
import * as msgpack from 'msgpack-lite';
import { promisify } from 'util';
import * as zlib from 'zlib';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

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
  private readonly cleanupInterval = 30000; // 1 minuto
  private readonly config: RedisConfigWithCompression;

  private lastHealthCheckTime = 0;
  private healthCheckStatus = {
    lastSuccessful: false,
    consecutiveFailures: 0,
    lastError: null as Error | null,
    lastCheckTime: 0
  };

  private compressionMetrics = {
    totalCompressed: 0,
    totalSaved: 0,
    averageCompressionRatio: 0,
    lastCompressionRatio: 0
  };

  constructor(
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly retryService: RetryService
  ) {
    this.config = redisConfig; // Almacenamos la configuración
    this.redis = new Redis(process.env.REDIS_URL, redisConfig);
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


  private updateCompressionMetrics(originalSize: number, compressedSize: number) {
    this.compressionMetrics.totalCompressed++;
    this.compressionMetrics.totalSaved += (originalSize - compressedSize);
    this.compressionMetrics.lastCompressionRatio = originalSize / compressedSize;
    this.compressionMetrics.averageCompressionRatio = 
      this.compressionMetrics.totalSaved / 
      (this.compressionMetrics.totalCompressed * originalSize);

    this.logger.debug(
      `📊 Compresión - Ratio: ${this.compressionMetrics.lastCompressionRatio.toFixed(2)}x, ` +
      `Ahorro: ${(originalSize - compressedSize)} bytes`
    );
  }



  async get<T>(key: string): Promise<CacheResponse<T>> {
    return this.retryService.execute(
      () => this.circuitBreaker.execute<T>(
        async () => {
          try {
            const startTime = performance.now();
            const value = await this.redis.getBuffer(key);
            
            if (value) {
              try {
                // Intentamos descomprimir (si está comprimido)
                let finalValue: Buffer;
                let wasCompressed = false;
                
                try {
                  finalValue = await gunzip(value);
                  wasCompressed = true;
                } catch {
                  // Si falla la descompresión, asumimos que no está comprimido
                  finalValue = value;
                }
                
                // Decodificamos usando msgpack
                const parsed = msgpack.decode(finalValue);
                await this.setLocalCache(key, parsed);
                
                const endTime = performance.now();
                this.logger.debug(
                  `⚡ Cache hit en Redis: ${key} ` +
                  `(${Math.round(endTime - startTime)}ms)` +
                  `${wasCompressed ? ' [Descomprimido]' : ''}`
                );
                
                return {
                  success: true,
                  data: parsed,
                  source: 'redis',
                  details: {
                    cached: true,
                    responseTime: endTime - startTime,
                    lastCheck: new Date().toISOString(),
                    wasCompressed
                  }
                };
              } catch (error) {
                this.logger.warn(
                  `⚠️ Error procesando datos para key ${key}: ${error.message}`
                );
                throw error;
              }
            }
  
            this.logger.debug(`❓ Cache miss en Redis: ${key}`);
            return { 
              success: false, 
              source: 'none',
              details: {
                cached: false,
                lastCheck: new Date().toISOString()
              }
            };
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
              source: 'local',
              details: {
                cached: true,
                lastCheck: new Date().toISOString()
              }
            };
          }
          return { 
            success: false, 
            source: 'none',
            details: {
              cached: false,
              lastCheck: new Date().toISOString()
            }
          };
        },
        `get:${key}`
      ),
      {
        maxAttempts: 3,
        context: `get:${key}`,
        retryableErrors: [
          /ECONNREFUSED/,
          /ETIMEDOUT/,
          /ECONNRESET/,
          'CONNECTION_ERROR',
          'REDIS_NOT_CONNECTED'
        ]
      }
    );
  }


  async set(key: string, value: any, ttl?: number): Promise<CacheResponse> {
    return this.retryService.execute(
      () => this.circuitBreaker.execute(
        async () => {
          try {
            const startTime = performance.now();
            
            // Codificamos usando msgpack
            const encoded = msgpack.encode(value);
            
            // Comprimimos solo si el tamaño es mayor a 1KB
            let finalData: Buffer;
            let compressionApplied = false;
            
            if (encoded.length > 1024) {
              finalData = await gzip(encoded);
              compressionApplied = true;
              this.updateCompressionMetrics(encoded.length, finalData.length);
            } else {
              finalData = encoded;
            }
            
            if (ttl) {
              await this.redis.setex(key, ttl, finalData);
            } else {
              await this.redis.set(key, finalData);
            }
            
            await this.setLocalCache(key, value, ttl);
            
            const endTime = performance.now();
            const compressionRatio = compressionApplied ? 
              (encoded.length / finalData.length).toFixed(2) : '1.00';
            
            this.logger.debug(
              `💾 Cache establecido en Redis: ${key} ` +
              `(${Math.round(endTime - startTime)}ms` +
              `${compressionApplied ? `, ratio compresión: ${compressionRatio}x` : ''})` 
            );
            
            return { 
              success: true, 
              source: 'redis',
              details: {
                cached: true,
                lastCheck: new Date().toISOString(),
                responseTime: endTime - startTime,
                dataSize: compressionApplied ? {
                  original: encoded.length,
                  compressed: finalData.length,
                  ratio: Number(compressionRatio)
                } : undefined
              }
            };
          } catch (error) {
            this.logger.error(`🔥 Error al establecer cache para ${key}:`, error.stack);
            throw error;
          }
        },
        async () => {
          await this.setLocalCache(key, value, ttl);
          return { 
            success: true, 
            source: 'local',
            details: {
              cached: true,
              lastCheck: new Date().toISOString()
            }
          };
        },
        `set:${key}`
      ),
      {
        maxAttempts: 3,
        context: `set:${key}`,
        retryableErrors: [
          /ECONNREFUSED/,
          /ETIMEDOUT/,
          /ECONNRESET/,
          'CONNECTION_ERROR',
          'REDIS_NOT_CONNECTED'
        ]
      }
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

    
  getCompressionMetrics() {
    return {
      ...this.compressionMetrics,
      compressionEnabled: this.config.compression.enabled,
      compressionLevel: this.config.compression.level,
      compressionThreshold: this.config.compression.threshold,
      lastUpdateTime: new Date().toISOString()
    };
  }
  
}
