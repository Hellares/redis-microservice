import { Controller, Logger } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext, RpcException } from '@nestjs/microservices';
import { CacheService } from '../services/cache.service';
import { CircuitBreakerService } from '../services/circuit-breaker.service';
import { CacheResponse } from '../interfaces/cache-response.interface';

@Controller()
export class CacheController {
  private readonly logger = new Logger(CacheController.name);

  constructor(
    private readonly cacheService: CacheService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {}

  @MessagePattern({ cmd: 'cache.get' })
  async get(@Payload() key: string, @Ctx() context: RmqContext) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();

    try {
      this.logger.debug(`Getting cache for key: ${key}`);
      const result = await this.circuitBreaker.execute(
        () => this.cacheService.get(key),
        async () => ({ success: false, source: 'none' } as CacheResponse<unknown>),
        `get:${key}`
      );

      await this.safeAck(channel, originalMsg);
      return result;
    } catch (error) {
      await this.safeAck(channel, originalMsg);
      this.logger.error(`Error getting cache for key ${key}:`, error);
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
      this.logger.debug(`Setting cache for key: ${data.key}`);
      const result = await this.circuitBreaker.execute(
        () => this.cacheService.set(data.key, data.value, data.ttl),
        async () => ({ success: false, source: 'none' } as CacheResponse<unknown>),
        `set:${data.key}`
      );

      await this.safeAck(channel, originalMsg);
      return result;
    } catch (error) {
      await this.safeAck(channel, originalMsg);
      this.logger.error(`Error setting cache for key ${data.key}:`, error);
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
  
    try {
      this.logger.debug('📝 Procesando health check request');
    
      const healthResult = await this.circuitBreaker.execute(
        () => this.cacheService.healthCheck(),
        async () => ({ 
          success: false, 
          source: 'none', 
          data: false 
        }),
        'health-check'
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
          lastCheck: new Date().toISOString()
        }
      };
    
      this.logger.debug('✅ Health check response:', response);
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
    
      this.logger.error('❌ Health check fallido:', errorResponse);
      return errorResponse;
    }
  }

  @MessagePattern({ cmd: 'cache.clear' })
  async clearCache(@Ctx() context: RmqContext) {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();

    try {
      this.logger.debug('Clearing all cache');
      const result = await this.circuitBreaker.execute(
        () => this.cacheService.clearCache(),
        async () => ({ success: false, source: 'none' } as CacheResponse<void>),
        'clear-cache'
      );

      await this.safeAck(channel, originalMsg);
      return result;
    } catch (error) {
      await this.safeAck(channel, originalMsg);
      this.logger.error('Error clearing cache:', error);
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
      this.logger.debug(`Deleting cache for key: ${key}`);
      const result = await this.circuitBreaker.execute(
        () => this.cacheService.delete(key),
        async () => ({ success: false, source: 'none' } as CacheResponse<unknown>),
        `delete:${key}`
      );

      await this.safeAck(channel, originalMsg);
      return result;
    } catch (error) {
      await this.safeAck(channel, originalMsg);
      this.logger.error(`Error deleting cache for key ${key}:`, error);
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
      const result = await this.circuitBreaker.execute(
        () => this.cacheService.get(key),
        async () => ({ success: false, source: 'none' } as CacheResponse<unknown>),
        `exists:${key}`
      );

      await this.safeAck(channel, originalMsg);
      return { exists: result.success };
    } catch (error) {
      await this.safeAck(channel, originalMsg);
      this.logger.error(`Error checking existence for key ${key}:`, error);
      throw new RpcException({
        message: 'Error checking cache existence',
        error: error.message,
      });
    }
  }

  private async safeAck(channel: any, message: any): Promise<void> {
    try {
      if (channel?.ack && message) {
        await channel.ack(message);
        this.logger.debug('✅ Mensaje confirmado correctamente');
      }
    } catch (ackError) {
      this.logger.error('❌ Error en ACK:', {
        error: ackError.message,
        stack: ackError.stack
      });
    }
  }
}