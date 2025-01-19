import { RedisOptions } from 'ioredis';
import { envs } from './envs';

export const redisConfig: RedisOptions = {
  host: envs.redis.host,
  port: envs.redis.port,
  username: envs.redis.username,
  password: envs.redis.password,
  connectTimeout: 5000,     // 5 segundos máximo para conectar
  commandTimeout: 3000,     // 3 segundos máximo por comando
  maxRetriesPerRequest: 3,  // Reducir reintentos
  retryStrategy: (times: number) => {
    if (times > 3) {
      return null; // Dejar de reintentar después de 3 veces
    }
    const delay = Math.min(times * 1000, 3000);
    return delay;
  },
  enableReadyCheck: false,  // Deshabilitar para conexiones más rápidas
  lazyConnect: true
};