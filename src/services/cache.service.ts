import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { CircuitBreakerService } from './circuit-breaker.service';
import { redisConfig, RedisConfigWithCompression } from '../config/redis.config';
import { CacheResponse, CacheSource } from '../interfaces/cache-response.interface';
import { RetryService } from './retry-service';
import * as msgpack from 'msgpack-lite';
import { promisify } from 'util';
import * as zlib from 'zlib';
import { PinoLogger } from 'nestjs-pino';

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
  private readonly isDevelopment = process.env.NODE_ENV !== 'production';
  // private readonly logger = new Logger(CacheService.name);
  private readonly redis: Redis;
  private readonly localCache: Map<string, LocalCacheEntry>;
  private isConnected = false;
  private readonly localCacheTTL = 300000; // 5 minutos
  private readonly cleanupInterval = 30000; // 1 minuto
  private readonly config: RedisConfigWithCompression;
  private readonly MAX_LOCAL_CACHE_SIZE = 1000; // Configurable según necesidades
  private readonly MIN_CACHE_SIZE = Math.floor(this.MAX_LOCAL_CACHE_SIZE * 0.8); // Mantener 80% después de limpieza
  private readonly HEALTH_CHECK_TIMEOUT = 3000; // 3 segundos
  private readonly MAX_CONSECUTIVE_FAILURES = 3;
  

  private lastHealthCheckTime = 0;
  private healthCheckStatus = {
    lastSuccessful: false,
    consecutiveFailures: 0,
    lastError: null as Error | null,
    lastCheckTime: 0,
    lastResponse: null as any,
    degradedPerformance: false
  };

  private compressionMetrics = {
    totalCompressed: 0,
    totalSaved: 0,
    averageCompressionRatio: 0,
    lastCompressionRatio: 0
  };

  constructor(
    private readonly logger: PinoLogger,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly retryService: RetryService
  ) {
    //contexto para los logs
    this.logger.setContext('CacheService');

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
        this.healthCheckStatus.degradedPerformance = true;
        // Solo logueamos errores de conexión cuando realmente perdemos la conexión
        this.logger.error({err: error}, 'Conexion perdida con Redis');
      }
    });

    this.redis.on('connect', () => {
      if (!this.isConnected) {
        this.isConnected = true;
        // Solo logueamos la reconexión si estábamos desconectados
        this.logger.info('Conexión establecida con Redis');
      }
    });

    this.redis.on('ready', () => {
      if (this.healthCheckStatus.degradedPerformance) {
        this.logger.info('Redis recuperado y listo para operaciones');
        this.healthCheckStatus.degradedPerformance = false;
      }
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
    const cleanupStats = {
      ttlExpired: 0,
      sizeLimit: 0
    };
    
    // Paso 1: Limpiar entradas expiradas por TTL
    for (const [key, entry] of this.localCache.entries()) {
      const ttl = entry.ttl || this.localCacheTTL;
      if (now - entry.timestamp > ttl) {
        this.localCache.delete(key);
        cleanedEntries++;
        cleanupStats.ttlExpired++;
      }
    }
  
    // Paso 2: Si aún excedemos el tamaño máximo, eliminar por LRU y hits
    if (this.localCache.size > this.MAX_LOCAL_CACHE_SIZE) {
      const entries = Array.from(this.localCache.entries())
        .sort((a, b) => {
          // Primero ordenar por hits (menos hits primero)
          const hitsDiff = a[1].hits - b[1].hits;
          if (hitsDiff !== 0) return hitsDiff;
          // Si tienen mismos hits, ordenar por timestamp (más antiguos primero)
          return a[1].timestamp - b[1].timestamp;
        });
  
      // Calcular cuántas entradas necesitamos eliminar
      const entriesToRemove = this.localCache.size - this.MIN_CACHE_SIZE;
      
      // Eliminar las entradas menos utilizadas
      entries.slice(0, entriesToRemove).forEach(([key]) => {
        this.localCache.delete(key);
        cleanedEntries++;
        cleanupStats.sizeLimit++;
      });
    }
  
    // Logging de resultados si hubo limpieza
    if (cleanedEntries > 0 && this.isDevelopment) {
      // this.logger.debug(
      //   `Cache limpiado - Total: ${cleanedEntries} entradas eliminadas ` +
      //   `(TTL: ${cleanupStats.ttlExpired}, Tamaño: ${cleanupStats.sizeLimit}) ` +
      //   `- Nuevo tamaño: ${this.localCache.size}`
      // );
      this.logger.debug({
        cleaned: cleanedEntries,
        byTTL: cleanupStats.ttlExpired,
        bySize: cleanupStats.sizeLimit,
        newSize: this.localCache.size
      }, 'Cache limpiado');
    }
  
    // Opcional: Emitir métricas para monitoreo
    this.emitCacheMetrics({
      size: this.localCache.size,
      cleanedEntries,
      ...cleanupStats
    });
  }

  private emitCacheMetrics(metrics: {
    size: number;
    cleanedEntries: number;
    ttlExpired: number;
    sizeLimit: number;
  }) {
    //! Aquí puedes integrar con tu sistema de métricas
    //! Por ejemplo: Prometheus, StatsD, etc.
  }


  private updateCompressionMetrics(originalSize: number, compressedSize: number) {
    this.compressionMetrics.totalCompressed++;
    this.compressionMetrics.totalSaved += (originalSize - compressedSize);
    this.compressionMetrics.lastCompressionRatio = originalSize / compressedSize;
    this.compressionMetrics.averageCompressionRatio = 
      this.compressionMetrics.totalSaved / 
      (this.compressionMetrics.totalCompressed * originalSize);

    // this.logger.debug(
    //   `📊 Compresión - Ratio: ${this.compressionMetrics.lastCompressionRatio.toFixed(2)}x, ` +
    //   `Ahorro: ${(originalSize - compressedSize)} bytes`
    // );
    // Solo logueamos en modo desarrollo y usando el formato de objeto para eficiencia
    if (this.isDevelopment) {
      this.logger.debug({
        ratio: this.compressionMetrics.lastCompressionRatio.toFixed(2),
        saved: (originalSize - compressedSize),
        originalSize,
        compressedSize
      }, 'Compresión realizada');
    }
  }

  async get<T>(key: string): Promise<CacheResponse<T>> {
    const localValue = this.getFromLocalCache(key);
    if (localValue) {
      if (this.isDevelopment) {
        // this.logger.debug(`Cache local: ${key}`);
        this.logger.debug({ key, source: 'local' }, 'Cache hit');
      }
  
      this.fetchFromRedis<T>(key).catch((err) =>
        // this.logger.warn(`⚠️ Error actualizando desde Redis: ${err.message}`)
        this.logger.warn({ err, key }, 'Error actualizando desde Redis')
      );
  
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
  
    return this.fetchFromRedis<T>(key);
  }

   private async fetchFromRedis<T>(key: string): Promise<CacheResponse<T>> {
    return this.retryService.execute(
      () => this.circuitBreaker.execute<T>(
        async () => {
          try {
            const startTime = performance.now();
            const value = await this.redis.getBuffer(key);
  
            if (value) {
              let finalValue: Buffer;
              let wasCompressed = false;
  
              try {
                finalValue = await gunzip(value);
                wasCompressed = true;
              } catch {
                finalValue = value;
              }
  
              const parsed = msgpack.decode(finalValue);
              await this.setLocalCache(key, parsed);
  
              const endTime = performance.now();
              const responseTime = Math.round(endTime - startTime);

              if (this.isDevelopment) {
                this.logger.debug({
                  key,
                  source: 'redis',
                  responseTime,
                  compressed: wasCompressed
                }, 'Cache hit');
              }
  
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
            }
  
            if (this.isDevelopment) {
              this.logger.debug({ key }, 'Cache miss');
            }
            return {
              success: false,
              source: 'none',
              details: {
                cached: false,
                lastCheck: new Date().toISOString()
              }
            };
          } catch (error) {
            // this.logger.error(`🔥 Error en Redis para key ${key}:`, error.stack);
            this.logger.error({ err: error, key }, 'Error en Redis');
            throw error;
          }
        },
        undefined,
        `fetch:${key}`
      ),
      {
        maxAttempts: 3,
        context: `fetch:${key}`,
        retryableErrors: [/ECONNREFUSED/, /ETIMEDOUT/, /ECONNRESET/, 'CONNECTION_ERROR', 'REDIS_NOT_CONNECTED']
      }
    );
  }

  async set(key: string, value: any, ttl?: number): Promise<CacheResponse> {
    return this.retryService.execute(
      () => this.circuitBreaker.execute(
        async () => {
          try {
            const startTime = performance.now();
            const encoded = msgpack.encode(value);
            let finalData: Buffer;
            let compressionApplied = false;
            
            if (encoded.length > 5120) {
              finalData = await gzip(encoded, { level: 4 });
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
            const responseTime = Math.round(endTime - startTime);
            
            // if (this.isDevelopment) {
            //   const compressionInfo = compressionApplied ? 
            //     `, ratio: ${(encoded.length / finalData.length).toFixed(2)}x` : '';
            //   this.logger.debug(
            //     // `💾 Cache set: ${key} (${Math.round(endTime - startTime)}ms${compressionInfo})`
            //     `Cache set: ${key}`
            //   );
            // }
            // Logging con formato de objeto
            if (this.isDevelopment) {
              this.logger.debug({
                key,
                responseTime,
                compressed: compressionApplied,
                ratio: compressionApplied ? 
                  Number((encoded.length / finalData.length).toFixed(2)) : undefined
              }, 'Cache set');
            }
            
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
                  ratio: Number((encoded.length / finalData.length).toFixed(2))
                } : undefined
              }
            };
          } catch (error) {
            // this.logger.error(`🔥 Error al establecer cache para ${key}:`, error.stack);
            this.logger.error({ err: error, key }, 'Error al establecer cache');
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
    const now = Date.now();
    
    // Si el último check fue exitoso y no han pasado más de 10 segundos, retornamos el cache
    if (this.healthCheckStatus.lastSuccessful && 
        now - this.healthCheckStatus.lastCheckTime < 10000 &&
        this.healthCheckStatus.lastResponse) {
      return this.healthCheckStatus.lastResponse;
    }

    try {
      const pingPromise = this.redis.ping();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Health check timeout')), this.HEALTH_CHECK_TIMEOUT);
      });
  
      const isPingSuccessful = await Promise.race([
        pingPromise,
        timeoutPromise
      ]) === 'PONG';
  
      this.healthCheckStatus.lastCheckTime = now;
      this.isConnected = isPingSuccessful;
        
      if (isPingSuccessful) {
        // Solo logueamos si hubo fallos previos y ahora se recuperó
        if (this.healthCheckStatus.consecutiveFailures > 0) {
          //this.logger.debug('✅ Health check exitoso - Recuperado después de fallos');
          this.logger.info({
            previousFailures: this.healthCheckStatus.consecutiveFailures
          }, 'Health check exitoso - Recuperado después de fallos');
        }
        this.healthCheckStatus.consecutiveFailures = 0;
        this.healthCheckStatus.lastSuccessful = true;
        this.healthCheckStatus.lastError = null;
        this.healthCheckStatus.degradedPerformance = false;
      } else {
        this.healthCheckStatus.consecutiveFailures++;
        this.healthCheckStatus.lastSuccessful = false;
        this.healthCheckStatus.degradedPerformance = true;
        
        // Solo logueamos cuando alcanzamos un umbral de fallos
        if (this.healthCheckStatus.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
          this.logger.warn(
            // `⚠️ Health check fallido consecutivo #${this.healthCheckStatus.consecutiveFailures}`
            { consecutiveFailures: this.healthCheckStatus.consecutiveFailures },
            'Health check fallido consecutivo'
          );
        }
      }
        
      const response: CacheResponse<boolean> = {
        success: isPingSuccessful,
        source: 'redis' as CacheSource,
        data: isPingSuccessful,
        details: {
          consecutiveFailures: this.healthCheckStatus.consecutiveFailures,
          cached: false,
          lastCheck: new Date(this.healthCheckStatus.lastCheckTime).toISOString(),
          degradedPerformance: this.healthCheckStatus.degradedPerformance
        }
      };

      // Cacheamos la respuesta
      this.healthCheckStatus.lastResponse = response;      
      return response;

    } catch (error) {
      this.isConnected = false;
      this.healthCheckStatus.consecutiveFailures++;
      this.healthCheckStatus.lastSuccessful = false;
      this.healthCheckStatus.lastError = error;
      this.healthCheckStatus.degradedPerformance = true;
  
      // Solo logueamos errores cuando son diferentes al último error o cuando alcanzamos umbrales
      if (!this.healthCheckStatus.lastError || 
          this.healthCheckStatus.lastError.message !== error.message ||
          this.healthCheckStatus.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
        this.logger.error('❌ Health check fallido:', {
          error: error.message,
          consecutiveFailures: this.healthCheckStatus.consecutiveFailures,
          timestamp: new Date().toISOString()
        });
      }
  
      const errorResponse: CacheResponse<boolean> = {
        success: false,
        source: 'none' as CacheSource,
        error: error.message,
        details: {
          lastError: error.message,
          consecutiveFailures: this.healthCheckStatus.consecutiveFailures,
          lastCheck: new Date().toISOString(),
          degradedPerformance: true
        }
      };

      // Cacheamos la respuesta de error
      this.healthCheckStatus.lastResponse = errorResponse;
      
      throw error;
    }
  }

  async clearCache(): Promise<CacheResponse<void>> {
    try {
      // Primero limpiamos el caché local
      this.localCache.clear();
      
      // Luego intentamos limpiar Redis
      await this.redis.flushall();
      this.logger.info('Cache completamente limpiado (local y Redis)');
      
      return {
        success: true,
        source: 'redis'
      };
    } catch (error) {
      this.logger.error('Error al limpiar cache:', error.stack);
      throw error;
    }
  }

  async delete(key: string): Promise<CacheResponse> {
    return this.circuitBreaker.execute(
      async () => {
        try {
          const deleted = await this.redis.del(key);
          this.localCache.delete(key);
          this.logger.debug(`Cache eliminado para key: ${key}`);
          return {
            success: deleted > 0,
            source: 'redis'
          };
        } catch (error) {
          this.logger.error(` Error al eliminar cache para ${key}:`, error.stack);
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
      this.logger.warn('Desconectado de Redis y limpiado caché local');
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

  async clearByPattern(pattern: string): Promise<CacheResponse<void>> {
    try {
      // Usar SCAN en lugar de KEYS para producción
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
      
      this.logger.info(`Limpiadas ${keys.length} keys con patrón: ${pattern}`);
      
      return {
        success: true,
        source: 'redis',
        details: {
          responseTime: 0,
          lastCheck: new Date().toISOString(),
          keysDeleted: keys.length
        }
      };
    } catch (error) {
      this.logger.error(`❌ Error limpiando keys con patrón ${pattern}:`, error);
      throw error;
    }
  }  
}
