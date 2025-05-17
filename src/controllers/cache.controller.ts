import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext, RpcException } from '@nestjs/microservices';
import { PinoLogger } from 'nestjs-pino';
import { CacheService } from '../services/cache.service';
import { CircuitBreakerService } from '../services/circuit-breaker.service';
import { CacheResponse } from '../interfaces/cache-response.interface';
import { RetryService } from 'src/services/retry-service';
import { ParsedRedisKey } from 'src/utils/redis-key-parser';

@Controller()
export class CacheController {
  private readonly isDevelopment = process.env.NODE_ENV !== 'production';
  // private readonly logger = new Logger(CacheController.name);
  private lastHealthCheckTime = 0;
  private readonly minHealthCheckInterval = 30000; // 30 segundos mínimo entre checks
  private lastHealthCheckResponse: any = null;


  constructor(
    private readonly logger: PinoLogger,
    private readonly cacheService: CacheService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly retryService: RetryService, // Agregamos RetryService
  ) {
    this.logger.setContext('CacheController');
  }

  
  @MessagePattern({ cmd: 'cache.get' })
  async get(@Payload() key: string, @Ctx() context: RmqContext) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();

    try {
      const result = await this.retryService.execute(
        () => this.circuitBreaker.execute(
          () => this.cacheService.get(key),
          async () => ({ success: false, source: 'none' }),
          `get:${key}`
        ),
        {
          context: `controller:get:${key}`,
          maxAttempts: 3
        }
      );

      await this.safeAck(channel, originalMsg);
      return result;
    } catch (error) {
      await this.safeAck(channel, originalMsg);
      // this.logger.error(`Error getting cache for ${key}:`, error);
      this.logger.error({ err: error, key: key }, 'Error getting cache');
      throw new RpcException({
        message: 'Error retrieving from cache',
        error: error.message,
      });
    }
  }

 
  @MessagePattern({ cmd: 'cache.set' })
  async set(@Payload() data: { key: string; value: any; ttl?: number }, @Ctx() context: RmqContext) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();

    try {
      const result = await this.retryService.execute(
        () => this.circuitBreaker.execute(
          () => this.cacheService.set(data.key, data.value, data.ttl),
          async () => ({ success: false, source: 'none' }),
          `set:${data.key}`
        ),
        {
          context: `controller:set:${data.key}`,
          maxAttempts: 3
        }
      );

      await this.safeAck(channel, originalMsg);
      return result;
    } catch (error) {
      await this.safeAck(channel, originalMsg);
      // this.logger.error(`Error setting cache for ${data.key}:`, error);
      this.logger.error({ err: error, key: data.key }, 'Error setting cache');
      throw new RpcException({
        message: 'Error setting cache',
        error: error.message,
      });
    }
  }
 
  @MessagePattern({ cmd: 'cache.health' })
  async healthCheck(@Ctx() context: RmqContext) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();
    const now = Date.now();

    try {
      // Verificar el intervalo mínimo entre health checks
      if (now - this.lastHealthCheckTime < this.minHealthCheckInterval && this.lastHealthCheckResponse) {
        await this.safeAck(channel, originalMsg);
        return this.lastHealthCheckResponse;
      }

      // Solo registrar en debug si hay un problema previo
      if (this.circuitBreaker.getState() !== 'CLOSED' || this.isDevelopment) {
        this.logger.debug('Procesando health check request');
      }
    
      const healthResult = await this.retryService.execute(
        () => this.circuitBreaker.execute(
          () => this.cacheService.healthCheck(),
          async () => ({ 
            success: false, 
            source: 'none', 
            data: false 
          }),
          'health-check'
        ),
        {
          context: 'controller:health-check',
          maxAttempts: 2,
          initialBackoff: 500
        }
      );
    
      await this.safeAck(channel, originalMsg);
    
      const response = {
        status: healthResult.data ? 'healthy' : 'unhealthy',
        circuitBreaker: this.circuitBreaker.getState(),
        timestamp: new Date().toISOString(),
        success: healthResult.success,
        source: healthResult.source,
        microserviceConnection: true,
        details: {
          redisConnected: healthResult.data,
          circuitBreakerState: this.circuitBreaker.getState(),
          lastCheck: new Date().toISOString(),
          retryAttempts: healthResult.details?.attempts
        }
      };

      this.lastHealthCheckTime = now;
      this.lastHealthCheckResponse = response;
    
      // Solo loguear la respuesta si hay un cambio en el estado o si hubo un problema
      if (this.circuitBreaker.getState() !== 'CLOSED' || !healthResult.success) {
        this.logger.debug({ response }, 'Health check response');
      }

      return response;
    } catch (error) {
      await this.safeAck(channel, originalMsg);
      
      const errorResponse = {
        status: 'unhealthy',
        error: error.message || 'Error interno en el servicio',
        timestamp: new Date().toISOString(),
        microserviceConnection: false,
        circuitBreaker: this.circuitBreaker.getState()
      };
    
      this.logger.error({ err: error, response: errorResponse }, 'Health check fallido');
      
      this.lastHealthCheckTime = now;
      this.lastHealthCheckResponse = errorResponse;
      
      return errorResponse;
    }
  }


  @MessagePattern({ cmd: 'cache.clear' })
  async clearCache(@Ctx() context: RmqContext) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();

    try {
      // Solo loguear en modo desarrollo
      if (this.isDevelopment) {
        this.logger.debug('Clearing all cache');
      }
      const result = await this.retryService.execute(
        () => this.circuitBreaker.execute(
          () => this.cacheService.clearCache(),
          async () => ({ success: false, source: 'none' } as CacheResponse<void>),
          'clear-cache'
        ),
        {
          context: 'controller:clear-cache',
          maxAttempts: 2 // Menos intentos para clear cache
        }
      );

      await this.safeAck(channel, originalMsg);
      return result;
    } catch (error) {
      await this.safeAck(channel, originalMsg);
      this.logger.error({ err: error }, 'Error clearing cache');
      throw new RpcException({
        message: 'Error clearing cache',
        error: error.message,
      });
    }
  }

  @MessagePattern({ cmd: 'cache.delete' })
  async delete(@Payload() key: string, @Ctx() context: RmqContext) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();

    try {
      if (this.isDevelopment) {
        this.logger.debug({ key }, 'Deleting cache');
      }
      
      const result = await this.retryService.execute(
        () => this.circuitBreaker.execute(
          () => this.cacheService.delete(key),
          async () => ({ success: false, source: 'none' } as CacheResponse<unknown>),
          `delete:${key}`
        ),
        {
          context: `controller:delete:${key}`,
          maxAttempts: 3
        }
      );

      await this.safeAck(channel, originalMsg);
      return result;
    } catch (error) {
      await this.safeAck(channel, originalMsg);
      this.logger.error({ err: error, key }, 'Error deleting cache');
      throw new RpcException({
        message: 'Error deleting from cache',
        error: error.message,
      });
    }
  }

  @MessagePattern({ cmd: 'cache.exists' })
  async exists(@Payload() key: string, @Ctx() context: RmqContext) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();

    try {
      const result = await this.retryService.execute(
        () => this.circuitBreaker.execute(
          () => this.cacheService.get(key),
          async () => ({ success: false, source: 'none' } as CacheResponse<unknown>),
          `exists:${key}`
        ),
        {
          context: `controller:exists:${key}`,
          maxAttempts: 2
        }
      );

      await this.safeAck(channel, originalMsg);
      return { exists: result.success };
    } catch (error) {
      await this.safeAck(channel, originalMsg);
      this.logger.error({ err: error, key }, 'Error checking cache existence');
      throw new RpcException({
        message: 'Error checking cache existence',
        error: error.message,
      });
    }
  }

  @MessagePattern({ cmd: 'cache.clearPattern' })
  async clearPattern(@Payload() pattern: string, @Ctx() context: RmqContext) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();

    try {
      if (this.isDevelopment) {
        this.logger.debug({ pattern }, 'Limpiando cache por patron');
      }
      
      const result = await this.retryService.execute(
        () => this.circuitBreaker.execute(
          () => this.cacheService.clearByPattern(pattern),
          async () => ({ success: false, source: 'none' } as CacheResponse<void>),
          `clear-pattern:${pattern}`
        ),
        {
          context: `controller:clear-pattern:${pattern}`,
          maxAttempts: 2
        }
      );

      await this.safeAck(channel, originalMsg);
      return result;
    } catch (error) {
      await this.safeAck(channel, originalMsg);
      this.logger.error({ err: error, pattern }, 'Error limpiando cache por patron');
      throw new RpcException({
        message: 'Error limpiando cache por patron',
        error: error.message,
      });
    }
  }

  private async safeAck(channel: any, message: any): Promise<void> {
    try {
      if (channel?.ack && message) {
        await channel.ack(message);
        //this.logger.debug('✅ Mensaje confirmado correctamente');
      }
    } catch (ackError) {
      this.logger.error({ err: ackError }, 'Error en ACK');
    }
  }


  //************************************************************ */ */

  // Métodos a añadir en cache.controller.ts
@MessagePattern({ cmd: 'cache.clearByEntity' })
async clearByEntity(@Payload() data: { entityType: string, entityId: string }, @Ctx() context: RmqContext) {
  const channel = context.getChannelRef();
  const originalMsg = context.getMessage();

  try {
    if (this.isDevelopment) {
      this.logger.debug({ entityType: data.entityType, entityId: data.entityId }, 'Limpiando cache por entidad');
    }
    
    const result = await this.retryService.execute(
      () => this.circuitBreaker.execute(
        () => this.cacheService.clearByEntity(data.entityType, data.entityId),
        async () => ({ success: false, source: 'none' } as CacheResponse<void>),
        `clear-entity:${data.entityType}:${data.entityId}`
      ),
      {
        context: `controller:clear-entity:${data.entityType}:${data.entityId}`,
        maxAttempts: 2
      }
    );

    await this.safeAck(channel, originalMsg);
    return result;
  } catch (error) {
    await this.safeAck(channel, originalMsg);
    this.logger.error({ err: error, entityType: data.entityType, entityId: data.entityId }, 'Error limpiando cache por entidad');
    throw new RpcException({
      message: 'Error limpiando cache por entidad',
      error: error.message,
    });
  }
}

@MessagePattern({ cmd: 'cache.clearByKeySegments' })
async clearByKeySegments(@Payload() segments: string[], @Ctx() context: RmqContext) {
  const channel = context.getChannelRef();
  const originalMsg = context.getMessage();

  try {
    if (this.isDevelopment) {
      this.logger.debug({ segments }, 'Limpiando cache por segmentos de clave');
    }
    
    const result = await this.retryService.execute(
      () => this.circuitBreaker.execute(
        () => this.cacheService.clearByKeySegments(segments),
        async () => ({ success: false, source: 'none' } as CacheResponse<void>),
        `clear-segments:${segments.join(':')}`
      ),
      {
        context: `controller:clear-segments:${segments.join(':')}`,
        maxAttempts: 2
      }
    );

    await this.safeAck(channel, originalMsg);
    return result;
  } catch (error) {
    await this.safeAck(channel, originalMsg);
    this.logger.error({ err: error, segments }, 'Error limpiando cache por segmentos de clave');
    throw new RpcException({
      message: 'Error limpiando cache por segmentos de clave',
      error: error.message,
    });
  }
}



@MessagePattern({ cmd: 'cache.clearByKeyComponents' })
async clearByKeyComponents(@Payload() components: Partial<ParsedRedisKey>, @Ctx() context: RmqContext) {
  const channel = context.getChannelRef();
  const originalMsg = context.getMessage();

  try {
    if (this.isDevelopment) {
      this.logger.debug({ components }, 'Limpiando cache por componentes');
    }
    
    const result = await this.retryService.execute(
      () => this.circuitBreaker.execute(
        () => this.cacheService.clearByKeyComponents(components),
        async () => ({ success: false, source: 'none' } as CacheResponse<void>),
        `clear-components`
      ),
      {
        context: `controller:clear-components`,
        maxAttempts: 2
      }
    );

    await this.safeAck(channel, originalMsg);
    return result;
  } catch (error) {
    await this.safeAck(channel, originalMsg);
    this.logger.error({ err: error, components }, 'Error limpiando cache por componentes');
    throw new RpcException({
      message: 'Error limpiando cache por componentes',
      error: error.message,
    });
  }
}

@MessagePattern({ cmd: 'cache.clearBySimilarKeys' })
async clearBySimilarKeys(
  @Payload() data: { sampleKey: string, filterComponents: Array<keyof ParsedRedisKey> },
  @Ctx() context: RmqContext
) {
  const channel = context.getChannelRef();
  const originalMsg = context.getMessage();

  try {
    if (this.isDevelopment) {
      this.logger.debug({ sampleKey: data.sampleKey, filterComponents: data.filterComponents }, 
                        'Limpiando cache por clave similar');
    }
    
    const result = await this.retryService.execute(
      () => this.circuitBreaker.execute(
        () => this.cacheService.clearBySimilarKeys(data.sampleKey, data.filterComponents),
        async () => ({ success: false, source: 'none' } as CacheResponse<void>),
        `clear-similar:${data.sampleKey}`
      ),
      {
        context: `controller:clear-similar`,
        maxAttempts: 2
      }
    );

    await this.safeAck(channel, originalMsg);
    return result;
  } catch (error) {
    await this.safeAck(channel, originalMsg);
    this.logger.error({ err: error, data }, 'Error limpiando cache por clave similar');
    throw new RpcException({
      message: 'Error limpiando cache por clave similar',
      error: error.message,
    });
  }
}

@MessagePattern({ cmd: 'cache.clearByMainEntity' })
async clearByMainEntity(
  @Payload() data: { entityType: string, entityId: string },
  @Ctx() context: RmqContext
) {
  const channel = context.getChannelRef();
  const originalMsg = context.getMessage();

  try {
    if (this.isDevelopment) {
      this.logger.debug({ entityType: data.entityType, entityId: data.entityId }, 
                        'Limpiando cache por entidad principal');
    }
    
    const result = await this.retryService.execute(
      () => this.circuitBreaker.execute(
        () => this.cacheService.clearByMainEntity(data.entityType, data.entityId),
        async () => ({ success: false, source: 'none' } as CacheResponse<void>),
        `clear-main-entity:${data.entityType}:${data.entityId}`
      ),
      {
        context: `controller:clear-main-entity`,
        maxAttempts: 2
      }
    );

    await this.safeAck(channel, originalMsg);
    return result;
  } catch (error) {
    await this.safeAck(channel, originalMsg);
    this.logger.error({ err: error, data }, 'Error limpiando cache por entidad principal');
    throw new RpcException({
      message: 'Error limpiando cache por entidad principal',
      error: error.message,
    });
  }
}

@MessagePattern({ cmd: 'cache.clearByEntityPair' })
async clearByEntityPair(
  @Payload() data: { 
    entityType: string, 
    entityId: string, 
    subEntityType: string, 
    subEntityId: string 
  },
  @Ctx() context: RmqContext
) {
  const channel = context.getChannelRef();
  const originalMsg = context.getMessage();

  try {
    if (this.isDevelopment) {
      this.logger.debug(data, 'Limpiando cache por par de entidades');
    }
    
    const result = await this.retryService.execute(
      () => this.circuitBreaker.execute(
        () => this.cacheService.clearByEntityPair(
          data.entityType, 
          data.entityId, 
          data.subEntityType, 
          data.subEntityId
        ),
        async () => ({ success: false, source: 'none' } as CacheResponse<void>),
        `clear-entity-pair:${data.entityType}:${data.entityId}:${data.subEntityType}:${data.subEntityId}`
      ),
      {
        context: `controller:clear-entity-pair`,
        maxAttempts: 2
      }
    );

    await this.safeAck(channel, originalMsg);
    return result;
  } catch (error) {
    await this.safeAck(channel, originalMsg);
    this.logger.error({ err: error, data }, 'Error limpiando cache por par de entidades');
    throw new RpcException({
      message: 'Error limpiando cache por par de entidades',
      error: error.message,
    });
  }
}
}